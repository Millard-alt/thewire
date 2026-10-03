/**
 * Gallery, gallery categories and multi-photo articles.
 *
 * These are the features 017 introduced, and nothing else in the repo covered
 * them: `npm test` walks the role gates, the credits suite walks the credits
 * tab, the smoke suite walks sign-in/out. The gallery page, the category cards
 * and the article photo strip were all new code with no assertion against
 * them, which is exactly how the `galleryCategoryId` / `categoryId` key
 * mismatch shipped -- every suite passed while the gallery showed every photo
 * as unfiled.
 *
 * Demo mode only -- this never touches the live database.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:5203/";
const PASS = process.env.TEST_PASS || "password123";
const OWNER = process.env.TEST_OWNER || "chief.owner";

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
  await page.locator('#auth-form-signin button[type="submit"]').click();
  await page.waitForTimeout(1400);
}

/** Open the admin panel and switch to one tab. */
async function openAdmin(page, tab) {
  await page.evaluate(() => {
    document.querySelector('[data-action="open-admin"], #open-admin')?.click();
  });
  await page.waitForTimeout(900);
  await page.click(`[data-admin-tab="${tab}"]`);
  await page.waitForTimeout(700);
}

/** Is this category name present in the Owner's category manager list? */
function categoryListed(page, name) {
  return page
    .$$eval("#gallery-category-form ~ ul li span", (els, want) =>
      els.some((el) => el.textContent.trim() === want), name
    )
    .catch(() => false);
}

/**
 * Decline the push-notification prompt if it is currently on screen.
 *
 * The publication asks a first-time reader for alert permission the moment they
 * open a story. It is a full-screen modal, so it swallows every click meant for
 * the article underneath -- a test that clicks the photo strip while it is up
 * fails on the prompt's backdrop, not on the strip.
 *
 * The dialog element is always present in the DOM and merely hidden once the
 * reader has answered, so visibility has to be checked: clicking a hidden node
 * just times out. It is re-armed each time an article is opened, so this has to
 * be callable at more than one point in a test.
 */
async function dismissAlertGate(page) {
  const dismiss = await page.$("#alert-gate-dismiss");
  if (dismiss && (await dismiss.isVisible())) {
    await dismiss.click();
    await page.waitForTimeout(500);
  }
}

/** Horizontal overflow in CSS pixels. 0 or less means the layout fits. */
function overflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

const browser = await chromium.launch();
try {
  /* --- 1. the gallery door, and that it opens the gallery page --- */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => problems.push(`[front] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[front] ${m.text()}`);
    });

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    const doors = await page.$$("[data-gallery-open]");
    check("gallery door is on the front page", doors.length > 0, `${doors.length} found`);

    if (doors.length) {
      await doors[0].click();
      await page.waitForTimeout(900);

      const cards = await page.$$("[data-gallery-card]");
      check("door opens the gallery page", cards.length > 0, `${cards.length} card(s)`);

      // A separate page, so the door must no longer be ON SCREEN. Assert on
      // visibility, not on presence: the door legitimately stays in the DOM
      // inside #publication-view, which is now `hidden`. Counting nodes here
      // reported a false failure for a gallery that was working correctly.
      const doorStillVisible = await page.$$eval("[data-gallery-open]", (els) =>
        els.some((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
      );
      check("front page is replaced by the gallery", doorStillVisible === false);

      // The view swap itself: exactly one reader view on screen.
      const visibleViews = await page.evaluate(() =>
        ["publication-view", "gallery-view", "credits-view"]
          .filter((id) => {
            const el = document.getElementById(id);
            return el && !el.classList.contains("hidden");
          })
      );
      check(
        "exactly one reader view is on screen",
        visibleViews.length === 1 && visibleViews[0] === "gallery-view",
        `visible: ${visibleViews.join(",") || "none"}`
      );
    }

    /* --- 2. a category card expands, collapses, and reports its state --- */
    {
      const category = await page.$("[data-gallery-category]");
      if (!category) {
        check("gallery exposes category cards", false, "no [data-gallery-category]");
      } else {
        const id = await category.getAttribute("data-gallery-category");
        const sel = `[data-gallery-panel="${id}"]`;
        check("each category has a photo panel", Boolean(await page.$(sel)), `id=${id}`);

        const hiddenBefore = await page.$eval(sel, (el) => el.hidden);
        await category.click();
        await page.waitForTimeout(600);
        const hiddenAfter = await page.$eval(sel, (el) => el.hidden);

        check(
          "clicking a category card expands it",
          hiddenBefore === true && hiddenAfter === false,
          `hidden ${hiddenBefore} -> ${hiddenAfter}`
        );

        const photos = await page.$$eval(`${sel} img`, (els) => els.length);
        check("the expanded category lists its photos", photos > 0, `${photos} photo(s)`);

        await category.click();
        await page.waitForTimeout(500);
        check("clicking again collapses it", (await page.$eval(sel, (el) => el.hidden)) === true);

        // aria-expanded must track reality, or a screen reader is told the
        // opposite of what is on screen.
        const expanded = await category.getAttribute("aria-expanded");
        check("aria-expanded tracks the panel", expanded === "false", `aria-expanded=${expanded}`);
      }
    }

    /* --- 3. mobile-first: no sideways scroll at any phone width --- */
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(400);
      const over = await overflow(page);
      check(`gallery fits a ${width}px phone`, over <= 1, `overflow=${over}px`);
    }
    await page.close();
  }

  /* --- 4. the Owner panel: create a gallery category, then delete it --- */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => problems.push(`[owner] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[owner] ${m.text()}`);
    });

    await signIn(page, OWNER);
    await openAdmin(page, "media");

    check(
      "Owner sees the category manager",
      Boolean(await page.$("#gallery-category-form")),
      "#gallery-category-form"
    );

    const name = "Test Gallery Category";
    await page.fill("#gallery-category-name", name);
    await page.click('#gallery-category-form button[type="submit"]');
    await page.waitForTimeout(1200);

    check("a new category is listed", await categoryListed(page, name), name);
    check(
      "the category is selectable in the media form",
      await page.$$eval(
        "#media-category option",
        (els, want) => els.some((e) => e.textContent.trim() === want),
        name
      )
    );

    // It must also get its own card on the public page, not just in the panel.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const door = await page.$("[data-gallery-open]");
    if (door) {
      await door.click();
      await page.waitForTimeout(700);
    }
    const cardNames = await page.$$eval("[data-gallery-card]", (els) =>
      els.map((e) => e.innerText.trim())
    );
    // The card heading is uppercased by CSS, and `innerText` returns the
    // RENDERED text, so a category created as "Test Gallery Category" reads back
    // as "TEST GALLERY CATEGORY". Compare case-insensitively.
    check(
      "the new category gets its own card on the public page",
      cardNames.some((t) => t.toLowerCase().includes(name.toLowerCase())),
      `${cardNames.length} card(s)`
    );

    /* --- 5. delete it again, so the suite leaves the panel as it found it --- */
    await openAdmin(page, "media");
    page.once("dialog", (d) => d.accept());
    await page.click(`[data-action="gallery-category-delete"][data-name="${name}"]`);
    await page.waitForTimeout(900);

    check("the category is removed again", (await categoryListed(page, name)) === false);
    await page.close();
  }

  /* --- 6. the article photo strip: the cap, removal, and the reader view --- */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => problems.push(`[extras] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[extras] ${m.text()}`);
    });

    await signIn(page, OWNER);
    await openAdmin(page, "content");
    await page.click('[data-action="article-new"]');
    await page.waitForTimeout(700);

    check(
      "the article editor offers a supporting-photo picker",
      Boolean(await page.$("#article-extra-file"))
    );

    await page.fill("#article-title", "Gallery check dispatch");
    // Four URLs, one more than the cap. The cap has to be enforced in the
    // client, not merely documented, or the fourth photo reaches the article.
    await page.fill(
      "#article-extra-url",
      "https://example.org/a.jpg, https://example.org/b.jpg, " +
        "https://example.org/c.jpg, https://example.org/d.jpg"
    );
    await page.click('#article-form button[type="submit"]');
    await page.waitForTimeout(1200);

    // A new article is created as "Pending Review" and the front page only
    // carries published stories, so the Owner has to approve it before the
    // reader can ever meet it. Skip this and the assertion below fails for a
    // reason that has nothing to do with the photo strip.
    await openAdmin(page, "content");
    await page.waitForTimeout(600);
    const approved = await page.evaluate((title) => {
      // Rows are <article class="panel-raised">. Scope to that: `closest("div,...")`
      // matches the button's own flex-row wrapper, which holds only the buttons
      // and never the title, so the lookup silently found nothing.
      const row = [...document.querySelectorAll("article.panel-raised")].find(
        (el) => el.querySelector("h3")?.textContent.trim() === title
      );
      const btn = row?.querySelector("[data-action='article-publish']");
      if (!btn) return false;
      btn.click();
      return true;
    }, "Gallery check dispatch");
    await page.waitForTimeout(1200);
    check("the new article can be approved for publication", approved);

    // The editor dialog closes on save, so the cap cannot be read back from it.
    // Assert it where the reader meets it: on the published article.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // The publication asks a first-time reader for notification permission the
    // moment they open a story. It is a full-screen modal, so it swallows every
    // click meant for the article underneath. Clear it before opening the story,
    // and again after, because it is re-armed on every open.
    await dismissAlertGate(page);

    const opened = await page.evaluate(() => {
      // The `data-read` button reads "Read the full dispatch", so the TITLE lives
      // on the card around it. Match the card, then click its own button --
      // searching for the title inside the button can never match.
      const card = [...document.querySelectorAll("article.panel-raised")].find((el) =>
        (el.querySelector("h3")?.textContent || "").includes("Gallery check dispatch")
      );
      const btn = card?.querySelector("[data-read]");
      btn?.click();
      return Boolean(btn);
    });
    await page.waitForTimeout(1000);

    // Re-armed by the open above, so clear it again before reading the modal.
    await dismissAlertGate(page);

    const toggle = await page.$("[data-photo-toggle]");
    if (!opened || !toggle) {
      check("the saved article shows a photo strip", false, "no [data-photo-toggle]");
    } else {
      check("the saved article shows a photo strip", true);

      const panel = '[data-photo-panel="strip"]';
      check(
        "the strip starts collapsed",
        (await page.$eval(panel, (el) => el.hidden)) === true
      );

      const shown = await page.$$eval(`${panel} img`, (els) => els.length);
      check("the strip holds at most 3 photos", shown > 0 && shown <= 3, `${shown} of 4 saved`);

      // Opening a story re-arms the notification prompt, so it can be sitting on
      // top of the article again by now. Dismiss it before touching the strip,
      // or the click lands on the prompt's backdrop instead.
      await dismissAlertGate(page);

      await toggle.click();
      await page.waitForTimeout(500);
      check(
        "tapping the strip expands it in place",
        (await page.$eval(panel, (el) => el.hidden)) === false
      );
      check(
        "aria-expanded follows the strip",
        (await toggle.getAttribute("aria-expanded")) === "true"
      );

      await toggle.click();
      await page.waitForTimeout(400);
      check(
        "tapping again collapses it",
        (await page.$eval(panel, (el) => el.hidden)) === true
      );
    }

    await page.close();
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.log("\n=== console / page errors ===");
  problems.forEach((p) => console.log(`  ${p}`));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} gallery checks passed`);

if (failed.length || problems.length) {
  console.log("\nFAILED:");
  failed.forEach((f) => console.log(`  - ${f.name}  ${f.detail}`));
  process.exit(1);
}
console.log("RESULT: PASS");