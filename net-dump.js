const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const httpProxy = require("http-proxy");

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node net-dump.js <config.json>");
  process.exit(1);
}
const configDir = path.dirname(path.resolve(configPath));

const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const config = {
  main_log: raw.main_log,
  request_logs: raw.request_logs ?? "./requests",
  mappings: (raw.mappings || []).map((m) => {
    const inCfg = m.in || {};
    const outCfg = m.out || {};
    const inPort = inCfg.port;
    const outPort = outCfg.port;
    let ssl = inCfg.ssl;
    if (ssl) {
      ssl = { ...ssl };
      if (ssl.key) ssl.key = fs.readFileSync(path.resolve(configDir, ssl.key));
      if (ssl.cert)
        ssl.cert = fs.readFileSync(path.resolve(configDir, ssl.cert));
    }
    return {
      name: m.name ?? `${inPort}->${outPort}`,
      in: {
        port: inPort,
        interface: inCfg.interface ?? "0.0.0.0",
        ssl,
      },
      out: {
        host: outCfg.host ?? "localhost",
        port: outPort,
        https: !!outCfg.https,
      },
      replace: m.replace || {},
    };
  }),
};

function getLogDetails(
  requestLogsDir,
  name,
  method,
  urlPath,
  statusCode,
  timestamp,
) {
  const time = timestamp || new Date().toISOString().slice(11, 23);
  const base = `${time} ${name} ${method} ${urlPath} ${statusCode}`
    .replace(/\s/g, "_")
    .replace(/[/\\?*:|"]/g, "-");
  let filename = `${base}.txt`;
  let seq = null;
  if (fs.existsSync(path.join(requestLogsDir, filename))) {
    seq = 0;
    while (
      fs.existsSync(
        path.join(requestLogsDir, (filename = `${base} ${seq}.txt`)),
      )
    )
      seq++;
  }
  const nameNoExt = seq === null ? base : `${base} ${seq}`;
  return { filename, nameNoExt, timestamp: time, seq };
}

function streamFromBuffer(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

function writeLog(
  requestLogsDir,
  mainLogPath,
  logDetails,
  req,
  body,
  resLine,
  resHeaders,
  resBody,
) {
  const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
  const reqHeaders = Object.entries(req.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const log = `>>>> REQUEST\n${reqLine}\n${reqHeaders}\n\n${body.toString("utf8")}\n\n------------------------\n\n<<<< RESPONSE\n${resLine}\n${resHeaders}\n\n${resBody.toString("utf8")}`;

  const detailPath = path.join(requestLogsDir, logDetails.filename);
  fs.writeFileSync(detailPath, log);
  console.log(logDetails.nameNoExt);
  if (mainLogPath) {
    const mainLine = `${logDetails.filename} ${req.url}\n`;
    fs.appendFileSync(mainLogPath, mainLine);
  }
}

function createHandler(mapping, requestLogsDir, mainLogPath) {
  const proxy = httpProxy.createProxyServer({
    secure: false,
    selfHandleResponse: true,
    changeOrigin: true,
  });
  const pending = new WeakMap();

  proxy.on("proxyRes", (proxyRes, req, res) => {
    const ctx = pending.get(req);
    if (!ctx) return;
    pending.delete(req);
    const { body, timestamp } = ctx;
    const resChunks = [];
    proxyRes.on("data", (c) => resChunks.push(c));
    proxyRes.on("end", () => {
      let resBody = Buffer.concat(resChunks);
      if (mapping.replace?.response) {
        let resBodyStr = resBody.toString("utf8");
        for (const r of mapping.replace.response) {
          resBodyStr = resBodyStr.replaceAll(r.from, r.to);
        }
        resBody = Buffer.from(resBodyStr, "utf8");
      }
      const logDetails = getLogDetails(
        requestLogsDir,
        mapping.name,
        req.method,
        req.url.split("?")[0].slice(1),
        proxyRes.statusCode,
        timestamp,
      );
      const resLine = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
      const resHeaders = Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");

      writeLog(
        requestLogsDir,
        mainLogPath,
        logDetails,
        req,
        body,
        resLine,
        resHeaders,
        resBody,
      );

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(resBody);
    });
  });

  proxy.on("error", (err, req, res) => {
    const ctx = pending.get(req);
    if (!ctx) return;
    pending.delete(req);
    const { body, timestamp } = ctx;
    const errCode = err.code || "";
    const errMsg = err.message || "";
    let hint = "";
    if (
      errCode === "ECONNRESET" ||
      errCode === "EPIPE" ||
      errMsg.includes("socket hang up") ||
      errMsg.includes("Empty reply")
    ) {
      hint = ` (Backend closed connection. If backend requires HTTPS, set "out.https": true in config)`;
    }
    console.error(
      `[proxy error] ${mapping.name} -> ${mapping.out.host}:${mapping.out.port}`,
      errCode || errMsg,
      hint,
    );
    const logDetails = getLogDetails(
      requestLogsDir,
      mapping.name,
      req.method,
      req.url.split("?")[0].slice(1),
      502,
      timestamp,
    );
    writeLog(
      requestLogsDir,
      mainLogPath,
      logDetails,
      req,
      body,
      "HTTP/1.1 502 Bad Gateway",
      "",
      Buffer.from(`Bad Gateway: ${errMsg || errCode || ""}${hint}`),
    );
    if (!res.headersSent)
      res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(Buffer.from(`Bad Gateway: ${errMsg || errCode || ""}${hint}`));
  });

  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (mapping.replace?.request) {
        let bodyStr = body.toString("utf8");
        for (const r of mapping.replace.request) {
          bodyStr = bodyStr.replaceAll(r.from, r.to);
        }
        body = Buffer.from(bodyStr, "utf8");
      }
      const bodyStream = streamFromBuffer(body);
      const target = {
        host: mapping.out.host,
        port: mapping.out.port,
        protocol:
          mapping.out.https || mapping.out.port === 443 ? "https:" : "http:",
      };
      const timestamp = new Date().toISOString().slice(11, 23);
      delete req.headers["accept-encoding"];
      pending.set(req, { body, timestamp });
      proxy.web(req, res, { target, buffer: bodyStream });
    });
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (config.main_log) {
  ensureDir(path.dirname(config.main_log));
}
ensureDir(config.request_logs);

for (const m of config.mappings) {
  const handler = createHandler(m, config.request_logs, config.main_log);
  const server = m.in.ssl
    ? https.createServer(m.in.ssl, handler)
    : http.createServer(handler);
  const target = `${m.out.host}:${m.out.port}`;
  server.listen(m.in.port, m.in.interface, () => {
    console.log(
      `Proxy [${m.name}] listening on ${m.in.port} -> Targeting ${target}`,
    );
  });
}
