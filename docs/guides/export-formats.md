---
title: Export Formats
description: Deploy your generated CSP in any environment
---

# Export Formats

CSP Analyser can export your generated policy in seven deployment-ready formats. All examples below use the same policy:

```
default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com
```

## All formats

::: code-group

```text [header]
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com
```

```html [meta]
<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39; https://cdn.example.com; style-src &#39;self&#39; https://fonts.googleapis.com; img-src &#39;self&#39; data:; font-src &#39;self&#39; https://fonts.gstatic.com">
```

```nginx [nginx]
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com" always;
```

```apache [apache]
Header always set Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com"
```

```js [cloudflare]
export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Content-Security-Policy', 'default-src \'self\'; script-src \'self\' https://cdn.example.com; style-src \'self\' https://fonts.googleapis.com; img-src \'self\' data:; font-src \'self\' https://fonts.gstatic.com');
    return newResponse;
  }
};
```

```text [cloudflare-pages]
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com
```

```json [json]
{
  "directives": {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://cdn.example.com"],
    "style-src": ["'self'", "https://fonts.googleapis.com"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'", "https://fonts.gstatic.com"]
  },
  "policyString": "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com",
  "isReportOnly": false
}
```

:::

## Usage

::: code-group

```bash [CLI]
csp-analyser export <session-id> --format nginx
csp-analyser export <session-id> --format json --report-only
```

```json [MCP]
{
  "tool": "export_policy",
  "sessionId": "...",
  "format": "nginx",
  "isReportOnly": false
}
```

:::

## Deployment instructions

### Nginx

Write the output to a file and include it in your server block:

```bash
csp-analyser export <session-id> --format nginx > /etc/nginx/snippets/csp.conf
```

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    include snippets/csp.conf;

    # ... rest of config
}
```

Reload nginx after changes:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Apache

Add the output to your `.htaccess` or virtual host config. The `headers` module must be enabled:

```bash
sudo a2enmod headers
sudo systemctl restart apache2
```

```bash
csp-analyser export <session-id> --format apache >> /var/www/html/.htaccess
```

Or in your virtual host:

```apache
<VirtualHost *:443>
    ServerName example.com
    Header always set Content-Security-Policy "..."
</VirtualHost>
```

### Cloudflare Workers

Create or update a Worker that adds the CSP header to every response:

```bash
csp-analyser export <session-id> --format cloudflare > src/worker.js
```

Deploy with Wrangler:

```bash
npx wrangler deploy
```

### Cloudflare Pages

Add the output to your `_headers` file in the build output directory:

```bash
csp-analyser export <session-id> --format cloudflare-pages >> public/_headers
```

The `/*` pattern applies the header to all pages. Adjust the path pattern for more granular control.

### HTML meta tag

Add the `<meta>` tag inside your document's `<head>`:

```bash
csp-analyser export <session-id> --format meta
```

::: warning
The `meta` format automatically strips `report-uri` and `report-to` directives, as these are not supported in `<meta>` tags per the CSP specification.
:::

### JSON (programmatic)

Use the JSON format for integration with build tools, CI pipelines, or custom deployment scripts:

```bash
csp-analyser export <session-id> --format json > csp-policy.json
```

The JSON output includes the raw directive map, the assembled policy string, and the `isReportOnly` flag.

## Report-Only mode

All formats support `Content-Security-Policy-Report-Only` for safe testing in production:

```bash
csp-analyser export <session-id> --format nginx --report-only
```

This changes the header name from `Content-Security-Policy` to `Content-Security-Policy-Report-Only`, which logs violations without blocking resources. Deploy report-only first, monitor for unexpected violations, then switch to enforcing mode.
