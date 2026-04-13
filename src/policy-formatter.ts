import type { ExportFormat } from './types.js';

const META_STRIPPED_DIRECTIVES = ['report-uri', 'report-to'];

/**
 * Converts a directive map to a CSP policy string.
 *
 * Example: { "script-src": ["'self'", "https://cdn.example.com"] }
 *   → "script-src 'self' https://cdn.example.com"
 */
export function directivesToString(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

function headerName(isReportOnly: boolean): string {
  return isReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripMetaDirectives(directives: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(directives)) {
    if (!META_STRIPPED_DIRECTIVES.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Formats a directive map into a deployment-ready output string.
 */
export function formatPolicy(
  directives: Record<string, string[]>,
  format: ExportFormat,
  isReportOnly = false,
): string {
  const name = headerName(isReportOnly);

  switch (format) {
    case 'header': {
      const policy = directivesToString(directives);
      return `${name}: ${policy}`;
    }

    case 'meta': {
      const filtered = stripMetaDirectives(directives);
      const policy = directivesToString(filtered);
      return `<meta http-equiv="${name}" content="${escapeHtmlAttr(policy)}">`;
    }

    case 'nginx': {
      const policy = directivesToString(directives).replace(/"/g, '\\"');
      return `add_header ${name} "${policy}" always;`;
    }

    case 'apache': {
      const policy = directivesToString(directives).replace(/"/g, '\\"');
      return `Header always set ${name} "${policy}"`;
    }

    case 'cloudflare': {
      const policy = directivesToString(directives).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('${name}', '${policy}');
    return newResponse;
  }
};`;
    }

    case 'cloudflare-pages': {
      const policy = directivesToString(directives);
      return `/*\n  ${name}: ${policy}`;
    }

    case 'azure-frontdoor': {
      const policy = directivesToString(directives);
      return `resource ruleSet 'Microsoft.Cdn/profiles/ruleSets@2024-09-01' = {
  name: 'cspHeaders'
  parent: frontDoorProfile
}

resource cspRule 'Microsoft.Cdn/profiles/ruleSets/rules@2024-09-01' = {
  name: 'setCspHeader'
  parent: ruleSet
  properties: {
    order: 1
    conditions: []
    actions: [
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: '${name}'
          value: '${policy.replace(/'/g, "''")}'
        }
      }
    ]
  }
}`;
    }

    case 'helmet': {
      const helmetDirectives: Record<string, string[]> = {};
      for (const [directive, sources] of Object.entries(directives)) {
        // Convert kebab-case to camelCase for Helmet
        const camelKey = directive.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        helmetDirectives[camelKey] = sources;
      }
      const directiveEntries = Object.entries(helmetDirectives)
        .map(([key, sources]) => {
          const values = sources.map((s) => JSON.stringify(s)).join(', ');
          return `    ${key}: [${values}],`;
        })
        .join('\n');
      const method = isReportOnly ? 'reportOnly: true,\n  ' : '';
      return `app.use(
  helmet.contentSecurityPolicy({
    ${method}directives: {
${directiveEntries}
    },
  })
);`;
    }

    case 'json': {
      const policy = directivesToString(directives);
      return JSON.stringify(
        {
          directives,
          policyString: policy,
          isReportOnly,
        },
        null,
        2,
      );
    }
  }
}
