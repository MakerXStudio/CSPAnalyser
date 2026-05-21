import { getViolations, type Violation } from '@makerx/csp-analyser';
import { test, expect } from './csp-test';

interface DirectiveGroup {
  label: string;
  candidates: readonly string[];
}

const crossOriginBaseUrl = 'http://localhost:4174';

const expectedDirectiveGroups: readonly DirectiveGroup[] = [
  { label: 'script elements', candidates: ['script-src-elem', 'script-src'] },
  { label: 'script attributes', candidates: ['script-src-attr', 'script-src'] },
  { label: 'style elements', candidates: ['style-src-elem', 'style-src'] },
  { label: 'style attributes', candidates: ['style-src-attr', 'style-src'] },
  { label: 'images', candidates: ['img-src'] },
  { label: 'fonts', candidates: ['font-src'] },
  { label: 'connect', candidates: ['connect-src'] },
  { label: 'media', candidates: ['media-src'] },
  { label: 'objects', candidates: ['object-src'] },
  { label: 'frames', candidates: ['frame-src', 'child-src'] },
  { label: 'workers', candidates: ['worker-src', 'child-src'] },
  { label: 'forms', candidates: ['form-action'] },
  { label: 'base uri', candidates: ['base-uri'] },
];

function directiveNames(violations: readonly Violation[]): Set<string> {
  const names = new Set<string>();
  for (const violation of violations) {
    names.add(violation.effectiveDirective);
    names.add(violation.violatedDirective.split(' ')[0] ?? violation.violatedDirective);
  }
  return names;
}

function hasDirectiveViolation(
  violations: readonly Violation[],
  candidates: readonly string[],
  blockedUriPrefix: string,
): boolean {
  return violations.some(
    (violation) =>
      candidates.includes(violation.effectiveDirective) &&
      violation.blockedUri.startsWith(blockedUriPrefix),
  );
}

function missingDirectiveLabels(violations: readonly Violation[]): string[] {
  const names = directiveNames(violations);
  return expectedDirectiveGroups
    .filter((group) => !group.candidates.some((candidate) => names.has(candidate)))
    .map((group) => group.label);
}

test('captures a broad local CSP scenario matrix', async ({ page, cspCapture }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CSP scenario sample' })).toBeVisible();

  await page.getByTestId('legacy-inline-handler').click();
  await expect(page.locator('body')).toHaveAttribute('data-legacy-inline-handler', 'ran');

  const styleAttributeCard = page.getByTestId('style-attr-card');
  const styleAttributeButton = page.getByRole('button', { name: 'Toggle style attribute' });
  await expect(styleAttributeCard).toHaveCSS('border-color', 'rgb(226, 232, 240)');
  await styleAttributeButton.click();
  await expect(page.getByTestId('style-attr-status')).toHaveText('Style attribute changed');
  await expect(styleAttributeCard).toHaveCSS('border-color', 'rgb(249, 115, 22)');
  await styleAttributeButton.click();
  await expect(page.getByTestId('style-attr-empty')).toHaveText('Awaiting execution...');
  await expect(styleAttributeCard).toHaveCSS('border-color', 'rgb(226, 232, 240)');
  await styleAttributeButton.click();
  await expect(page.getByTestId('style-attr-status')).toHaveText('Style attribute changed');

  await page.getByRole('button', { name: 'Load API profile' }).click();
  await expect(page.getByTestId('profile-result')).toHaveText('Ada is CSP tester');

  await page.getByRole('button', { name: 'Send cross-origin beacon' }).click();
  await expect(page.getByTestId('cross-origin-connect-result')).toHaveText(
    'Cross-origin beacon attempted',
  );

  const dynamicStyleCard = page.getByTestId('dynamic-style-card');
  await page.getByRole('button', { name: 'Add dynamic style' }).click();
  await expect(page.getByTestId('dynamic-style-status')).toHaveText('Dynamic style added');
  await expect(styleAttributeCard).not.toHaveCSS('outline-color', 'rgb(249, 115, 22)');
  await expect(dynamicStyleCard).toHaveCSS('outline-color', 'rgb(249, 115, 22)');

  await page.getByRole('button', { name: 'Add inline script' }).click();
  await expect(page.getByTestId('dynamic-script-status')).toHaveText('Dynamic script added');
  await expect(page.locator('body')).toHaveAttribute('data-dynamic-inline-script', 'ran');

  await page.getByRole('button', { name: 'Load data image' }).click();
  await expect(page.getByTestId('data-image')).toBeVisible();

  await page.getByRole('button', { name: 'Start worker' }).click();
  await expect(page.getByTestId('worker-result')).toHaveText('worker-response');

  await page.getByRole('button', { name: 'Load media' }).click();
  await expect(page.getByTestId('audio-sample')).toBeVisible();

  await page.getByRole('button', { name: 'Open frame' }).click();
  await expect(
    page
      .frameLocator('iframe[title="CSP sample frame"]')
      .getByRole('heading', { name: 'Frame scenario' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open cross-origin frame' }).click();
  await expect(
    page
      .frameLocator('iframe[title="Cross-origin CSP sample frame"]')
      .getByRole('heading', { name: 'Cross-origin frame scenario' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Load object' }).click();
  await expect(page.locator('object[title="CSP sample object"]')).toBeVisible();

  await page.getByRole('button', { name: 'Submit form' }).click();
  await expect(page.getByTestId('form-status')).toHaveText('Form submitted');

  await page.getByRole('button', { name: 'Load lazy panel' }).click();
  await expect(page.getByTestId('lazy-panel')).toBeVisible();

  await expect
    .poll(
      () => {
        const violations = getViolations(cspCapture.db, cspCapture.sessionId);

        return {
          crossOriginConnect: hasDirectiveViolation(
            violations,
            ['connect-src'],
            crossOriginBaseUrl,
          ),
          crossOriginFrame: hasDirectiveViolation(
            violations,
            ['frame-src', 'child-src'],
            crossOriginBaseUrl,
          ),
          missingDirectives: missingDirectiveLabels(violations),
        };
      },
      {
        timeout: 10_000,
        message: 'all expected CSP directives and cross-origin sources should be observed',
      },
    )
    .toEqual({ crossOriginConnect: true, crossOriginFrame: true, missingDirectives: [] });
});

test('documents frame-ancestors with an embedder harness', async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    consoleMessages.push(message.text());
  });

  await page.goto('/');
  await page.evaluate((url) => {
    const iframe = document.createElement('iframe');
    iframe.title = 'Frame ancestors denied';
    iframe.src = url;
    document.body.appendChild(iframe);
  }, `${crossOriginBaseUrl}/frame-ancestors-denied.html`);

  await expect
    .poll(() => consoleMessages.some((message) => message.includes('frame-ancestors')), {
      timeout: 10_000,
      message: 'browser should report the enforced frame-ancestors block',
    })
    .toBe(true);
});
