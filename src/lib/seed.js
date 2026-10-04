/* =============================================================================
   src/lib/seed.js — DEFAULT PUBLICATION CONTENT
   -----------------------------------------------------------------------------
   Seed data used for (a) demo mode, and (b) the first Supabase load so the
   publication is never empty. Replace freely — once real rows exist in
   Supabase the app reads those instead.
   ========================================================================== */

export function createSeedState() {
  return {
    branding: {
      title: 'THE WIRE',
      subtitle: 'MJLA PRESS CLUB • INDEPENDENT VERIFIED DISPATCHES',
      edition: 'VOL. CXIV... NO. 32,841 — NAKURU, KENYA'
    },

    breakingNews: {
      enabled: true,
      label: 'BREAKING DISPATCH',
      headline:
        'MJLA Press Club Launches Sovereign Editorial Control Suite',
      subtext: 'Full administrative controls are live across the newsroom.',
      severity: 'Breaking',
      color: 'Red',
      sticky: true,
      dismissible: false,
      linkText: 'Read the announcement',
      linkUrl: '#'
    },

    notifications: {
      forced: false,
      permissionGranted: false,
      // Real count, read from `push_subscriptions` at runtime. The seed must NOT
      // invent a figure: showing "1420 subscribers" when zero devices have ever
      // opted in is a lie the Owner would act on.
      activeSubscriberCount: 0,
      history: []
    },

    todaysPickId: 'seed-article-1',
    weeklySlots: {
      article: 'seed-article-1',
      event: 'seed-article-2',
      picture: 'seed-article-3'
    },

    articles: [
      {
        id: 'seed-article-1',
        title: 'The Architecture of Civic Truth in Rift Valley Journalism',
        author: 'Grace Wanjiku',
        category: 'Investigation',
        date: 'Sept 24, 2026',
        image:
          'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80',
        caption: 'Press archives preserved in the Nakuru central room.',
        body: 'Journalism in Nakuru has long served as a vital pillar of civic life. As news platforms transition into digital frontiers, maintaining verified records remains sovereign. The MJLA Press Club continues to champion editorial integrity above algorithmic speed. Our correspondents keep physical day books, notarised transcripts and a public corrections ledger, because a story that cannot be audited is a rumour with a byline.',
        status: 'Published',
        featured: true
      },
      {
        id: 'seed-article-2',
        title: 'Rift Water Rights Assembly Convenes in the Lake Nakuru Basin',
        author: 'David Kiprop',
        category: 'Civic Dispatch',
        date: 'Sept 23, 2026',
        image:
          'https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80',
        caption: 'Delegates gathering at the lake basin.',
        body: 'Representatives from regional agricultural collectives gathered this morning to deliberate water conservation strategies. Local journalists documented the open council discussions and published the full attendance register alongside the minutes.',
        status: 'Published',
        featured: false
      },
      {
        id: 'seed-article-3',
        title: 'Shadows and Light: Photographs from the Old Railway Quarter',
        author: 'Amina Mohamed',
        category: 'Culture',
        date: 'Sept 22, 2026',
        image:
          'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80',
        caption: 'A quiet morning at the railway terminus.',
        body: "A visual exploration of Nakuru's historic railway neighbourhood reveals stories written into architectural facades and morning markets.",
        status: 'Published',
        featured: false
      },
      {
        id: 'seed-article-4',
        title: 'Pending Editorial Submission: Municipal Infrastructure Review',
        author: 'Samuel Ochieng',
        category: 'Investigation',
        date: 'Sept 24, 2026',
        image:
          'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80',
        caption: 'Draft review under editorial inspection.',
        body: 'This draft was submitted by staff and requires owner approval before it can run on the front page.',
        status: 'Pending Review',
        featured: false
      }
    ],

    assignments: [
      {
        id: 'seed-assignment-1',
        title: 'Cover the Nakuru Urban Planning Council session',
        reporter: 'David Kiprop',
        status: 'In Progress',
        deadline: 'Sept 26, 2026'
      },
      {
        id: 'seed-assignment-2',
        title: 'Investigate the Lake Nakuru water quality index',
        reporter: '',
        status: 'Open',
        deadline: 'Sept 30, 2026'
      }
    ],

    staff: [
      {
        id: 'seed-staff-1',
        name: 'Chief Owner',
        username: 'owner',
        // The Owner's real mailbox. Every other staffer is reached through a
        // hidden shadow address derived from their username, never a real inbox.
        email: 'melvinjonespressclub@gmail.com',
        role: 'Owner',
        status: 'Active'
      },
      {
        id: 'seed-staff-2',
        name: 'Grace Wanjiku',
        username: 'gwanjiku',
        email: 'grace.wanjiku@example.com',
        role: 'Writer',
        status: 'Active',
        // One portrait left awaiting review, so the Owner's review controls have
        // something real to act on in a fresh demo install. Without it the
        // Staff tab renders no review buttons at all and the approval flow looks
        // broken rather than empty.
        portrait_url:
          'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=320&q=80',
        portrait_status: 'pending'
      },
      {
        id: 'seed-staff-3',
        name: 'David Kiprop',
        username: 'dkiprop',
        email: 'david.kiprop@example.com',
        // 'Assignment Manager' was never a real role. No CHECK constraint
        // accepted it and normaliseRole() folded it to Writer, so the row and
        // the UI disagreed about what this person was.
        role: 'Board Manager',
        status: 'Active',
        portrait_url:
          'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=320&q=80',
        // Already approved, so the Staff tab shows both states at once: one
        // badge says "To review" with buttons, the other says "Portrait live".
        portrait_status: 'approved'
      }
    ],

    topPerformers: [
      {
        id: 'seed-performer-1',
        name: 'Grace Wanjiku',
        role: 'Writer',
        articlesCount: 42
      },
      {
        id: 'seed-performer-2',
        name: 'Amina Mohamed',
        role: 'Writer',
        articlesCount: 28
      }
    ],

    // Illustrative categories only. These exist so the Gallery page is not an
    // empty shell in demo mode; the Owner renames or deletes them freely. The
    // real ones live in the gallery_categories table.
    galleryCategories: [
      {
        id: 'seed-cat-1',
        name: 'CROSS COUNTRY',
        blurb: 'Long-distance athletics from around the region',
        cover:
          'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?auto=format&fit=crop&w=1200&q=80',
        position: 1
      },
      {
        id: 'seed-cat-2',
        name: 'SWIMMING GALA',
        blurb: 'Pool meets, championships and club nights',
        cover:
          'https://images.unsplash.com/photo-1530137073520-4ea6e2f10a48?auto=format&fit=crop&w=1200&q=80',
        position: 2
      }
    ],

    // `categoryId`, NOT `galleryCategoryId`. The whole app keys off
    // `categoryId` -- listGalleryByCategory(), updateMedia() and the media_assets
    // `category_id` column all read that name -- and the seed is merged straight
    // into state without passing through the row mapper, so a seed using the
    // longer name silently files every demo photo under "Uncategorised".
    // galleryOrder keeps the demo grid in a deliberate reading order.
    mediaLibrary: [
      {
        id: 'seed-media-1',
        url: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80',
        caption: 'Press archives',
        inGallery: true,
        galleryOrder: 1,
        categoryId: 'seed-cat-1'
      },
      {
        id: 'seed-media-2',
        url: 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80',
        caption: 'Lake basin council',
        inGallery: true,
        galleryOrder: 2,
        categoryId: 'seed-cat-1'
      },
      {
        id: 'seed-media-3',
        url: 'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80',
        caption: 'Railway quarter',
        inGallery: true,
        galleryOrder: 3,
        categoryId: 'seed-cat-2'
      }
    ],

    auditLogs: [
      {
        id: 'seed-audit-1',
        user: 'System',
        action: 'Initialised the publication workspace',
        time: 'Just now'
      }
    ]
  };
}

