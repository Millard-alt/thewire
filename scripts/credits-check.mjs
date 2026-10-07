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

    /* --- 4. EDIT an existing entry ---
     *
     * The regression test for the bug that shipped. The ADD path above was
     * always fine; it was the EDIT path that silently did nothing. updatePerson()
     * read patch.role while the panel sent role_label, so every argument
     * arrived as null, the server's coalesce() kept the old values, and the
     * client reported "Saved." over an edit that had not happened.
     *
     * It has to be asserted on the row after the panel has repainted, not on the
     * toast, because the toast claimed success in exactly this situation.
     */
    await page.click('[data-admin-tab="credits"]');
    await page.waitForTimeout(900);

    const editedRole = "Editor-at-Large";
    await page.evaluate((newRole) => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      const ada = forms.find(
        (f) => f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
      if (!ada) return;
      const role = ada.querySelector("[data-credits-role]");
      role.value = newRole;
      role.dispatchEvent(new Event("input", { bubbles: true }));
      role.dispatchEvent(new Event("change", { bubbles: true }));
      ada.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, editedRole);
    await page.waitForTimeout(1800);

    const afterEdit = await page.evaluate(() => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      const ada = forms.find(
        (f) => f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
      return ada ? ada.querySelector("[data-credits-role]")?.value : null;
    });
    check(
      "editing an existing role actually saves",
      afterEdit === editedRole,
      `role="${afterEdit}" expected="${editedRole}"`
    );

    // And it must survive a reload, which separates "the store holds it" from
    // "the input still has the old text in it".
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    await page.evaluate(() => {
      document.querySelector('[data-action="open-admin"], #open-admin')?.click();
    });
    await page.waitForTimeout(900);
    await page.click('[data-admin-tab="credits"]');
    await page.waitForTimeout(1100);
    const editAfterReload = await page.evaluate(() => {
      const forms = [...document.querySelectorAll("[data-credits-form]")];
      const ada = forms.find(
        (f) => f.querySelector("[data-credits-name]")?.value === "Ada Testwright"
      );
      return ada ? ada.querySelector("[data-credits-role]")?.value : null;
    });
    check(
      "edited role survives a reload",
      editAfterReload === editedRole,
      `role="${editAfterReload}" expected="${editedRole}"`
    );

    /* --- 5. roles group into bands, in the Owner's chosen order ---
     *
     * The page is meant to read like a Discord role list: same roles grouped
     * together, and the order of the bands controlled from the panel.
     */
    const bands = await page.evaluate(() =>
      [...document.querySelectorAll("[data-credits-band]")].map((el) => ({
        role: el.dataset.creditsBand,
        members: el.querySelectorAll("[data-credits-form]").length
      }))
    );
    check("credits group into role bands", bands.length > 0, `${bands.length} band(s)`);
    check(
      "every band has at least one member",
      bands.every((b) => b.members > 0),
      JSON.stringify(bands)
    );

    /* --- 6. THE TWO PAGES ARE SEPARATE, IN THE PANEL AND ON SCREEN ---
     *
     * Everything above exercises the Credits page. These check that the About Us
     * page is its own tab with its own fields, that a Credits card cannot acquire
     * an About heading, and that the two survive each other.
     */
    await page.click('[data-admin-tab="about"]');
    await page.waitForTimeout(1200);

    const aboutPanel = await page.evaluate(() => ({
      sections: [...document.querySelectorAll("[data-about-section]")].map((el) =>
        el.dataset.aboutSection.trim()
      ),
      names: [...document.querySelectorAll("[data-credits-name]")].map((i) => i.value),
      // Every About card must offer a roster; that is the field the Credits card
      // deliberately does not have.
      categorySelects: document.querySelectorAll("[data-credits-category]").length,
      forms: document.querySelectorAll("[data-credits-form]").length,
      scopes: [...document.querySelectorAll("[data-credits-form]")].map(
        (f) => f.dataset.rosterScope
      ),
      // The bleed, as an editable field: a Credits-only card must have no way to
      // pick a heading.
      creditsOnlyPageField: document.body.innerText.includes("Credits page"),
      previewHref: document.querySelector('a[href="#about"]')?.getAttribute("href")
    }));
    check(
      "About Us renders both rosters as sections",
      aboutPanel.sections.length === 2,
      aboutPanel.sections.join(" | ")
    );
    check(
      "the About tab is a separate tab, not a filter on the Credits one",
      aboutPanel.previewHref === "#about",
      `preview href=${aboutPanel.previewHref}`
    );
    check(
      "every About card carries the scope it belongs to",
      aboutPanel.scopes.length === 0 || aboutPanel.scopes.every((s) => s === "about_us"),
      aboutPanel.scopes.join(",")
    );
    check(
      "every About card offers a roster",
      aboutPanel.categorySelects === aboutPanel.forms && aboutPanel.forms > 0,
      `${aboutPanel.categorySelects} select(s) / ${aboutPanel.forms} card(s)`
    );
    check(
      "the About tab does NOT list the Credits-page-only entries",
      !aboutPanel.names.includes("School Athletic Association"),
      aboutPanel.names.join(", ")
    );

    // Add somebody to About Us, then confirm they did NOT turn up on Credits.
    await page.fill("#credits-add-name", "Grace Testbyliner");
    await page.fill("#credits-add-role", "Assistant President/Coordinator");
    await page.selectOption("#credits-add-category", "Behind the Bylines");
    await page.click("#credits-add-form button[type=submit]");
    await page.waitForTimeout(1600);

    const afterAboutAdd = await page.evaluate(() => ({
      onAbout: [...document.querySelectorAll("[data-credits-name]")].map((i) => i.value),
      // The long title is the wrap case the pill exists for. Matched
      // case-insensitively: `text-transform: uppercase` is a CSS effect, so
      // textContent is still the Owner's original casing and an uppercase match
      // finds nothing.
      longBadge: [...document.querySelectorAll(".role-pill")]
        .map((b) => b.textContent.trim())
        .find((t) => /assistant president/i.test(t))
    }));
    check(
      "a new About Us entry appears on the About tab",
      afterAboutAdd.onAbout.includes("Grace Testbyliner"),
      afterAboutAdd.onAbout.join(", ")
    );
    check(
      "a long role title renders as a pill, not a broken block",
      Boolean(afterAboutAdd.longBadge),
      `pill="${afterAboutAdd.longBadge}"`
    );

    await page.click('[data-admin-tab="credits"]');
    await page.waitForTimeout(1200);
    const creditsAfter = await page.evaluate(() => ({
      names: [...document.querySelectorAll("[data-credits-name]")].map((i) => i.value),
      categorySelects: document.querySelectorAll("[data-credits-category]").length
    }));
    check(
      "the About Us entry did NOT leak onto the Credits tab",
      !creditsAfter.names.includes("Grace Testbyliner"),
      creditsAfter.names.join(", ")
    );
    check(
      "no Credits card offers a roster select",
      creditsAfter.categorySelects === 0,
      `${creditsAfter.categorySelects} select(s) found`
    );

    /* --- 7. AND THE PUBLIC PAGES AGREE WITH THE PANEL --- */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    const publicPages = await page.evaluate(async () => {
      const click = (sel) => document.querySelector(sel)?.click();
      const out = {};
      click('[data-nav="about"]');
      await new Promise((r) => setTimeout(r, 1500));
      out.about = [...document.querySelectorAll(".about-card__name")]
        .map((n) => n.textContent.trim())
        .filter(Boolean);
      out.aboutCards = document.querySelectorAll(".about-card").length;
      click('[data-nav="credits"]');
      await new Promise((r) => setTimeout(r, 1500));
      out.credits = [...document.querySelectorAll(".credits-card__name")]
        .map((n) => n.textContent.trim())
        .filter(Boolean);
      return out;
    });

    check(
      "the About page shows the entry the Owner filed there",
      publicPages.about.includes("Grace Testbyliner"),
      publicPages.about.join(", ")
    );
    check(
      "the Credits page shows only Credits people",
      publicPages.credits.length > 0 && !publicPages.credits.includes("Grace Testbyliner"),
      publicPages.credits.join(", ")
    );
    check(
      "the two pages share no card",
      !publicPages.credits.some((n) => publicPages.about.includes(n)),
      `about=[${publicPages.about.join(",")}] credits=[${publicPages.credits.join(",")}]`
    );
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
