import { describe, it, expect } from 'vitest';
import {
  extractOrigin,
  isLocalhost,
  isSameOrigin,
  shouldUseMitmMode,
  generateWildcardDomain,
  normalizeBlockedUri,
} from '../../src/utils/url-utils.js';

describe('extractOrigin', () => {
  it('extracts origin for http URLs', () => {
    expect(extractOrigin('http://example.com/path')).toBe('http://example.com');
  });

  it('extracts origin for https URLs', () => {
    expect(extractOrigin('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('preserves non-default ports', () => {
    expect(extractOrigin('http://example.com:8080/path')).toBe('http://example.com:8080');
    expect(extractOrigin('https://example.com:3000/')).toBe('https://example.com:3000');
  });

  it('drops default ports', () => {
    expect(extractOrigin('http://example.com:80/path')).toBe('http://example.com');
    expect(extractOrigin('https://example.com:443/path')).toBe('https://example.com');
  });

  it('handles URLs with trailing slash', () => {
    expect(extractOrigin('https://example.com/')).toBe('https://example.com');
  });

  it('throws for malformed URLs', () => {
    expect(() => extractOrigin('not-a-url')).toThrow();
  });

  it('handles IPv6 addresses', () => {
    expect(extractOrigin('http://[::1]:8080/path')).toBe('http://[::1]:8080');
  });
});

describe('isLocalhost', () => {
  it('returns true for localhost', () => {
    expect(isLocalhost('localhost')).toBe(true);
  });

  it('returns true for 127.0.0.1', () => {
    expect(isLocalhost('127.0.0.1')).toBe(true);
  });

  it('returns true for [::1]', () => {
    expect(isLocalhost('[::1]')).toBe(true);
  });

  it('returns true for ::1', () => {
    expect(isLocalhost('::1')).toBe(true);
  });

  it('returns false for remote hostnames', () => {
    expect(isLocalhost('example.com')).toBe(false);
    expect(isLocalhost('192.168.1.1')).toBe(false);
  });

  it('returns false for 127.0.0.x (x != 1)', () => {
    expect(isLocalhost('127.0.0.2')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLocalhost('')).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('returns true for matching origins', () => {
    expect(isSameOrigin('https://example.com/a', 'https://example.com/b')).toBe(true);
  });

  it('returns false for different protocols', () => {
    expect(isSameOrigin('http://example.com/', 'https://example.com/')).toBe(false);
  });

  it('returns false for different hostnames', () => {
    expect(isSameOrigin('https://a.com/', 'https://b.com/')).toBe(false);
  });

  it('returns false for different ports', () => {
    expect(isSameOrigin('http://example.com:8080/', 'http://example.com:9090/')).toBe(false);
  });

  it('ignores path differences', () => {
    expect(isSameOrigin('https://example.com/page1', 'https://example.com/page2?q=1')).toBe(true);
  });
});

describe('shouldUseMitmMode', () => {
  it('returns false for http URLs', () => {
    expect(shouldUseMitmMode('http://example.com/')).toBe(false);
  });

  it('returns false for localhost https', () => {
    expect(shouldUseMitmMode('https://localhost:3000/')).toBe(false);
  });

  it('returns false for 127.0.0.1 https', () => {
    expect(shouldUseMitmMode('https://127.0.0.1:3000/')).toBe(false);
  });

  it('returns false for [::1] https', () => {
    expect(shouldUseMitmMode('https://[::1]:3000/')).toBe(false);
  });

  it('returns true for remote https', () => {
    expect(shouldUseMitmMode('https://example.com/')).toBe(true);
  });

  it('returns false for http localhost', () => {
    expect(shouldUseMitmMode('http://localhost:3000/')).toBe(false);
  });
});

describe('generateWildcardDomain', () => {
  it('generates wildcard for subdomains', () => {
    expect(generateWildcardDomain('cdn.example.com')).toBe('*.example.com');
  });

  it('generates wildcard for deep subdomains', () => {
    expect(generateWildcardDomain('a.b.example.com')).toBe('*.b.example.com');
  });

  it('returns hostname as-is for two-part domains', () => {
    expect(generateWildcardDomain('example.com')).toBe('example.com');
  });

  it('returns hostname as-is for single-label hostnames', () => {
    expect(generateWildcardDomain('localhost')).toBe('localhost');
  });
});

describe('normalizeBlockedUri', () => {
  it('normalizes empty string to none', () => {
    expect(normalizeBlockedUri('')).toBe("'none'");
  });

  it('normalizes inline to unsafe-inline', () => {
    expect(normalizeBlockedUri('inline')).toBe("'unsafe-inline'");
    expect(normalizeBlockedUri("'inline'")).toBe("'unsafe-inline'");
  });

  it('normalizes eval to unsafe-eval', () => {
    expect(normalizeBlockedUri('eval')).toBe("'unsafe-eval'");
    expect(normalizeBlockedUri("'eval'")).toBe("'unsafe-eval'");
  });

  it('normalizes data URIs', () => {
    expect(normalizeBlockedUri('data')).toBe('data:');
    expect(normalizeBlockedUri('data:image/png;base64,...')).toBe('data:');
  });

  it('normalizes blob URIs', () => {
    expect(normalizeBlockedUri('blob')).toBe('blob:');
    expect(normalizeBlockedUri('blob:https://example.com/uuid')).toBe('blob:');
  });

  it('normalizes about to none', () => {
    expect(normalizeBlockedUri('about')).toBe("'none'");
  });

  it('returns regular URLs as-is', () => {
    expect(normalizeBlockedUri('https://cdn.example.com/script.js')).toBe(
      'https://cdn.example.com/script.js',
    );
  });

  it('normalizes mediastream URIs', () => {
    expect(normalizeBlockedUri('mediastream')).toBe('mediastream:');
    expect(normalizeBlockedUri('mediastream:id')).toBe('mediastream:');
  });

  it('normalizes filesystem URIs', () => {
    expect(normalizeBlockedUri('filesystem')).toBe('filesystem:');
    expect(normalizeBlockedUri('filesystem:https://example.com/path')).toBe('filesystem:');
  });
});
