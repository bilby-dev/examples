// Load the page, run one core and one GW example in bilby test mode, switch
// bilby versions, and check the licences page. Run with: npx playwright test
// (BILBY_VERSION=<name> runs the examples with that bilby version instead of
// the site's default).
import { expect, test } from "@playwright/test";

const BILBY = process.env.BILBY_VERSION;
const query = BILBY ? `?bilby=${encodeURIComponent(BILBY)}` : "";

async function runExample(page, path) {
  await page.goto(`./${query}#${path}`);
  await expect(page.locator("#title")).toHaveText(path);
  await expect(page.locator("#status")).toHaveText(/^Ready/, { timeout: 180_000 });
  await expect(page.locator("body")).toHaveClass(/test-mode/); // the default
  await page.click("#run");
  const finished = page.locator("#output .info", { hasText: "finished in" });
  const failed = page.locator("#output .error");
  await expect(finished.or(failed).first()).toBeVisible({ timeout: 240_000 });
  await expect(failed, await failed.allTextContents().then((t) => t.join("\n"))).toHaveCount(0);
}

test("core example runs and its figures are in the Files tab", async ({ page }) => {
  await runExample(page, "core_examples/linear_regression.py");
  await page.locator("#tab-files").click();
  await page.locator("#file-list button", { hasText: /\.png/ }).first().click();
  await expect(page.locator("#file-view img")).toBeVisible();
});

test("an uploaded file can be read by the script, and is not an output", async ({ page }) => {
  await page.goto("./#scratch");
  await page.locator("#upload-input").setInputFiles({ name: "mydata.txt", mimeType: "text/plain", buffer: Buffer.from("1 2\n3 4\n") });
  await expect(page.locator("#file-list button[data-upload]")).toHaveText(/mydata\.txt/);
  await expect(page.locator("#status")).toHaveText(/^Ready/, { timeout: 180_000 });
  await page.evaluate(() => editor.load("import numpy as np\nprint('total', np.loadtxt('mydata.txt').sum())\n"));
  await page.click("#run");
  await expect(page.locator("#output")).toContainText("total 10.0", { timeout: 60_000 });
  await expect(page.locator("#file-list button[data-path]:not([data-upload])")).toHaveCount(0);
});

test("GW example installs LALSuite and runs", async ({ page }) => {
  await runExample(page, "gw_examples/injection_examples/fast_tutorial.py");
  await expect(page.locator("#output .info", { hasText: /^LAL .* installed$/ })).toBeVisible();
});

test("the version picker restarts Python with another bilby", async ({ page }) => {
  await page.goto("./#core_examples/linear_regression.py");
  await expect(page.locator("#status")).toHaveText(/^Ready/, { timeout: 180_000 });
  const versions = await page.evaluate(() => fetch("examples/versions.json").then((r) => r.json()));
  // BILBY_VERSION if that is not the default, else any other version
  const target = versions.versions.find((v) => v.name === BILBY && v.name !== versions.default)
    ?? versions.versions.find((v) => v.name !== versions.default);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.evaluate(() => editor.load("import bilby\nprint('running bilby', bilby.__version__)\n"));
  await page.selectOption("#bilby-version", target.name);
  await expect(page).toHaveURL(new RegExp(`\\?bilby=${escape(target.name)}#core_examples/linear_regression\\.py$`));
  await expect(page.locator("#status")).toHaveText(new RegExp(`^Ready: bilby ${escape(target.version)} ·`), { timeout: 180_000 });
  await page.click("#run");
  await expect(page.locator("#output")).toContainText(`running bilby ${target.version}`, { timeout: 60_000 });
});

test("licences page lists the hosted components", async ({ page }) => {
  await page.goto("./licenses.html");
  await expect(page.locator("h1")).toHaveText("Licences and source code");
  await expect(page.locator("body")).toContainText("LALSuite");
  await expect(page.locator("body")).toContainText("GPL-3.0-or-later");
});
