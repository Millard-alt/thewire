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
      subtitle: 'NAKURU PRESS CLUB • INDEPENDENT VERIFIED DISPATCHES',
      edition: 'VOL. CXIV... NO. 32,841 — NAKURU, KENYA'
    },

    breakingNews: {
      enabled: true,
      label: 'BREAKING DISPATCH',
      headline:
        'Nakuru Press Club Launches Sovereign Editorial Control Suite',
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
        body: 'Journalism in Nakuru has long served as a vital pillar of civic life. As news platforms transition into digital frontiers, maintaining verified records remains sovereign. The Nakuru Press Club continues to champion editorial integrity above algorithmic speed. Our correspondents keep physical day books, notarised transcripts and a public corrections ledger, because a story that cannot be audited is a rumour with a byline.',
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
        email: 'chief.owner@example.com',
        role: 'Owner',
        status: 'Active'
      },
      {
        id: 'seed-staff-2',
        name: 'Grace Wanjiku',
        username: 'gwanjiku',
        email: 'grace.wanjiku@example.com',
        role: 'Editor',
        status: 'Active'
      },
      {
        id: 'seed-staff-3',
        name: 'David Kiprop',
        username: 'dkiprop',
        email: 'david.kiprop@example.com',
        role: 'Assignment Manager',
        status: 'Active'
      }
    ],

    topPerformers: [
      {
        id: 'seed-performer-1',
        name: 'Grace Wanjiku',
        role: 'Senior Investigative Editor',
        articlesCount: 42
      },
      {
        id: 'seed-performer-2',
        name: 'Amina Mohamed',
        role: 'Photojournalist',
        articlesCount: 28
      }
    ],

    mediaLibrary: [
      {
        id: 'seed-media-1',
        url: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80',
        caption: 'Press archives'
      },
      {
        id: 'seed-media-2',
        url: 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80',
        caption: 'Lake basin council'
      },
      {
        id: 'seed-media-3',
        url: 'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80',
        caption: 'Railway quarter'
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

