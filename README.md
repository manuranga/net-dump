# net-dump — User guide

HTTP(S) reverse proxy that logs every request/response to files. This will help LLM AI Agents to create and debug applications. Typical browser MCP tools are too limited and consume too many tokens. In this approach AI can use use standard UNIX tools giving it more power.

## Run

```bash
npm install
node proxy.js <config.json>
```

Example: `node proxy.js config-icp.json`

## Config

Pass the config file path as the only argument.

| Field          | Default          | Description                                          |
| -------------- | ---------------- | ---------------------------------------------------- |
| `main_log`     | `./net-dump.txt` | One line per request: `filename url`                 |
| `request_logs` | `./requests`     | Directory for per-request dumps (created if missing) |
| `mappings`     | —                | List of proxy listeners                              |

**Per mapping:**

| Field          | Default                    | Description                                                                            |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `name`         | `in.port->out.port`        | Label in logs                                                                          |
| `in.port`      | —                          | Port the proxy listens on                                                              |
| `in.interface` | `0.0.0.0`                  | Bind address                                                                           |
| `in.ssl`       | —                          | `{ "key": "path", "cert": "path" }` for HTTPS listener (paths relative to config file) |
| `out.host`     | `localhost`                | Backend host                                                                           |
| `out.port`     | —                          | Backend port                                                                           |
| `out.https`    | `false` (true if port 443) | Use HTTPS to backend                                                                   |

## Output

- **main_log**: One line per request: `<request-log-filename> <url>`
- **request_logs/**: One file per request; namm (optional `-N` suffix on collision). Content: request (method, URL, headers, body) then response (status, headers, body).

Backend errors (e.g. connection refused) return 502 and are not written to request_logs.

## Sample AI Prompt

```
All the network traffic is logged to `app-logs` with file names `HH-mm-ss.sss <connection-name> <http-verb> <http-status-code>.txt`. Use these to analyze the application. Use standard UNIX tools to narrow down the files.
```
