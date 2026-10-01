/**
 * Credits page checks, driven through the real UI in Chromium.
 *
 * Two things are asserted:
 *   1. Only the Owner sees the Credits tab.
 *   2. The Owner can add a person with a photo, a free-text role and a role
 *      colour, and the entry survives a reload.
 *
 * Demo mode only -- this never touches the live database.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:5203/";
const PASS = process.env.TEST_PASS || "password123";
const OWNER = process.env.TEST_OWNER || "chief.owner";
const MANAGER = process.env.TEST_MANAGER || "reporter.jane";

const results = [];
const problems = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

async function signIn(page, username) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.querySelector('[data-action="open-auth"], #open-auth')?.click();
  });
  await page.waitForTimeout(400);
  await page.fill("#auth-signin-login", username);
  await page.fill("#auth-signin-password", PASS);
  // The submit button has no id of its own; it lives in the sign-in form.
  // An invented id (`#auth-signin-submit`) hangs here for 30s and then times
  // out, which reads as a product failure rather than a test-harness typo.
  await page.locator('#auth-form-signin button[type="submit"]').click();
  await page.waitForTimeout(1400);
}

const browser = await chromium.launch();
try {
  /* --- 1. gate --- */
  for (const [role, user, shouldSee] of [
    ["Owner", OWNER, true],
    ["Board Manager", MANAGER, false]
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (e) => problems.push(`[${role}] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[${role}] ${m.text()}`);
    });

    await signIn(page, user);
    await page.evaluate(() => {
      document.querySelector('[data-action="open-admin"], #open-admin')?.click();
    });
    await page.waitForTimeout(900);

    const tabs = await page.$$eval("[data-admin-tab]", (els) =>
      els.map((e) => e.dataset.adminTab)
    );
    const seesCredits = tabs.includes("credits");
    check(
      `${role} ${shouldSee ? "can" : "cannot"} open the Credits tab`,
      seesCredits === shouldSee,
      `tabs: ${tabs.join(", ")}`
    );
    await page.close();
  }

  /* --- 2. portrait review gate ---
   *
   * This is the regression test for the bug where a staffer uploaded a portrait,
   * was told "submitted for approval", and then nothing happened, ever. The
   * controls are Owner-only, so the assertion has to be made from both sides:
   * the Owner must get them, and a Board Manager must not.
   */
  for (const [role, user, shouldSee] of [
    ["Owner", OWNER, true],
    ["Board Manager", MANAGER, false]
  ]) {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    p.on("pageerror", (e) => problems.push(`[${role} portrait] ${e.message}`));
    await signIn(p, user);
    await p.evaluate(() => {
      document.querySelector('[data-action="open-admin"], #open-admin')?.click();
    });
    await p.waitForTimeout(900);
    await p.click('[data-admin-tab="staff"]');
    await p.waitForTimeout(700);

    const buttons = await p.$$eval("[data-action='portrait-approve'], [data-action='portrait-reject']",
      (els) => els.length);
    check(
      `${role} ${shouldSee ? "can" : "cannot"} approve portraits`,
      shouldSee ? buttons > 0 : buttons === 0,
      `${buttons} review control(s) rendered`
    );
    await p.close();
  }

  /* --- 3. owner round trip --- */
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => problems.push(`[owner] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[owner] ${m.text()}`);
  });

  await signIn(page, OWNER);
  await page.evaluate(() => {
    document.querySelector('[data-action="open-admin"], #open-admin')?.click();
  });
  await page.waitForTimeout(900);
  await page.click('[data-admin-tab="credits"]');
  await page.waitForTimeout(900);

  const addForm = await page.$("#credits-add-form");
  check("Credits tab renders the add form", Boolean(addForm));

  if (addForm) {
    // A free-text role that is NOT one of the built-in newsroom roles. The whole
    // point of the remake is that the Owner is not limited to a fixed list.
    const role = "Patron";
    await page.fill("#credits-add-name", "Ada Testwright");
    await page.fill("#credits-add-role", role);

    // The photo-URL box lives inside a collapsed <details>, so it is in the DOM
    // but not visible until the summary is opened. fill() waits for visibility,
    // so the <details> has to be expanded first.
    // The URL box lives inside a collapsed <details>. It must be opened LAST,
    // because typing into Name or Role repaints the whole tab and re-renders a
    // closed <details> -- opening it first leaves it shut again by the time we
    // get here.
    await page.click("#credits-add-form details > summary");
    await page.waitForTimeout(200);
    await page.fill("#credits-add-url", "https://example.com/ada.jpg");
    await page.evaluate(() => {
      const el = document.querySelector("#credits-add-color");
      el.value = "#ff8800";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click("#credits-add-form button[type=submit]");
    await page.waitForTimeout(1600);

    const onCard = await page.evaluate(() => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      const row = forms.find((f) =>
        f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
      if (!row) return null;
      return {
        role: row.querySelector("[data-credits-role]")?.value,
        colour: row.querySelector("[data-credits-color]")?.value
      };
    });
    check("new person appears with the typed role", onCard?.role === role, onCard ? `role="${onCard.role}"` : "row not found");
    check(
      "role colour saved",
      String(onCard?.colour || "").toLowerCase() === "#ff8800",
      onCard ? `colour="${onCard.colour}"` : ""
    );
// "Copy role colour" must lift the colour off ANOTHER person, not off
    // itself. Ada is added last, so her card's button copies whoever is first
    // (the Owner's dark red), which differs from her own orange.
    const copied = await page.evaluate(() => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      const ada = forms.find(
        (f) => f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
      const other = forms.find(
        (f) => f.querySelector("[data-credits-name]")?.value !== "Ada Testwright"
      );
      if (!ada || !other) return null;

      const before = ada.querySelector("[data-credits-color]")?.value;
      const expected = other.querySelector("[data-credits-color]")?.value;
      ada
        .querySelector('[data-action="credits-copy-colour"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const after = ada.querySelector("[data-credits-color]")?.value;
      return { before, expected, after };
    });
    check(
      "copy role colour copies from another person",
      copied?.after === copied?.expected && copied?.before !== copied?.after,
      copied
        ? `before=${copied.before} after=${copied.after} expected=${copied.expected}`
        : "no pair of cards"
    );

    // Survives a reload, i.e. it really went to the store.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    await page.evaluate(() => {
      document.querySelector('[data-action="open-admin"], #open-admin')?.click();
    });
    await page.waitForTimeout(900);
    await page.click('[data-admin-tab="credits"]');
    await page.waitForTimeout(1100);
    const afterReload = await page.evaluate(() => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      return forms.some(
        (f) => f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
    });
    check("entry survives a reload", afterReload);
  }
  await page.close();
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`\nCONSOLE/PAGE ERRORS (${problems.length}):`);
  for (const p of [...new Set(problems)].slice(0, 12)) console.log(`  ${p}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} credits checks passed`);
process.exit(failed.length || problems.length ? 1 : 0);
