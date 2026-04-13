# export

Export a session's CSP policy in a deployment-ready format.

## Usage

```bash
csp-analyser export [session-id] [options]
```

When `session-id` is omitted, the most recent completed session is used automatically.

## Options

| Option | Default | Description |
|---|---|---|
| `--strictness <level>` | `moderate` | Policy generation strictness: `strict`, `moderate`, or `permissive`. |
| `--format <fmt>` | `header` | Output format (see below). |
| `--report-only` | `false` | Generate a report-only header. |

## Formats

Seven export formats are available, covering the most common deployment targets.

### `header` (default)

A raw HTTP header string, ready to paste into any server configuration.

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'
```

### `meta`

An HTML `<meta>` tag for use in the document `<head>`. Directives not supported in `<meta>` tags (`report-uri`, `report-to`) are automatically stripped.

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'">
```

### `nginx`

An Nginx `add_header` directive.

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'" always;
```

### `apache`

An Apache `Header` directive for use in `.htaccess` or server config.

```apache
Header always set Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'"
```

### `cloudflare`

A Cloudflare Worker script that adds the CSP header to responses.

```js
export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Content-Security-Policy', '...');
    return newResponse;
  }
};
```

### `cloudflare-pages`

A Cloudflare Pages `_headers` file entry. Place the output in your `public/_headers` file.

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com
```

### `json`

A JSON object containing the directive map, the policy string, and the report-only flag. Useful for programmatic consumption.

```json
{
  "directives": {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://cdn.example.com"]
  },
  "policyString": "default-src 'self'; script-src 'self' https://cdn.example.com",
  "isReportOnly": false
}
```

## Examples

### Export for Nginx

```bash
csp-analyser export abc123 --format nginx > /etc/nginx/snippets/csp.conf
```

### Export as report-only for testing

```bash
csp-analyser export abc123 --format header --report-only
```

Output:
```
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' https://cdn.example.com
```

### Pipe JSON to jq

```bash
csp-analyser export abc123 --format json | jq '.directives | keys'
```

### Export Cloudflare Pages headers file

```bash
csp-analyser export abc123 --format cloudflare-pages > public/_headers
```
