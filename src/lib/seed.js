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
      title: 'THE PULSE',
      subtitle: 'MJLA PRESS CLUB • INDEPENDENT VERIFIED DISPATCHES',
      edition: 'Nakuru, Kenya'
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

    // The "This Week In The Pulse" band is on the front page unless the Owner
    // switches it off from the Curation tab. True is the default so a fresh
    // install — or a settings reset — looks exactly as it did before the
    // toggle existed.
    showThisWeek: true,

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

    /*
    Video interviews. camelCase to match what the views read -- mapInterviewRow()
    in store.js accepts either spelling, so these survive a round trip through
    mergeState(), which re-runs the mapper over the cached localStorage copy.

    `videoIds` holds BARE 11-character ids, exactly as the database does. Two of
    the rows carry multiple videos so the multi-embed detail view is exercised
    without editing anything, and the last one is deliberately 'pending' so the
    Owner's approval queue is not empty on a fresh demo load.

    Four rows, deliberately, because the public feed pages three at a time: a
    single demo interview would never reveal a page 2.
    */
    interviews: [
      {
        id: 'seed-interview-1',
        title: 'On Running a County Through a Drought Year',
        guest: 'Wanjiku Kamau',
        guestRole: 'Nakuru County Governor',
        interviewer: 'Grace Wanjiku',
        summary:
          'The Governor on water rationing, displaced herders, and why the county refused a centrally-imposed allocation formula.',
        description:
          'We sat down for ninety minutes at the county headquarters with Governor Wanjiku Kamau, three weeks after the second dry-season allocation was announced. She opened on the numbers: reservoir levels at 61 percent, a 40 percent cut in piped supply for three towns, and 12,000 households moved onto tanker deliveries.\n\nAsked whether the county had considered the allocation formula used elsewhere, she was blunt. "A formula built on a population register from 2019 does not know where people are now. It knows where they were. Water does not."\n\nOn the herders moving south along the Mau Escarpment, she was careful and unapologetic in equal measure, and repeatedly returned to a single theme: that the county government has spent four years being described as a problem to be solved, rather than an administration with a problem to solve.\n\nThe full conversation is published unedited, at the length it was recorded.',
        image:
          'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=1200&q=80',
        videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0'],
        status: 'published',
        authorAccountId: null,
        publishedAt: 'Sept 24, 2026',
        createdAt: 'Sept 22, 2026'
      },
      {
        id: 'seed-interview-2',
        title: 'The Archivist Who Refused to Digitise',
        guest: 'Samuel Otieno',
        guestRole: 'Keeper of the Nakuru Central Records',
        interviewer: 'Grace Wanjiku',
        summary:
          'On humidity, on what a digital copy is actually for, and on the case for keeping the paper day books.',
        description:
          'Samuel Otieno has kept the county record room for twenty-two years, through two floods and one near-total loss of the roof. He is, by some distance, the most qualified person in the county to digitise it, which is exactly why he has not.\n\nHis objection is not to digital preservation as such but to substitution. "A scan is a photograph of a document. It is not the document. The moment people believe the screen is the record, the paper stops being checked, and then the paper stops being correct, because nobody is looking."\n\nWe talked at length about what he does maintain digitally, about the day books the Press Club keeps, and about what he would want a young archivist to do with the collection he has been handed.',
        image:
          'https://images.unsplash.com/photo-1568667256549-094345857637?auto=format&fit=crop&w=1200&q=80',
        videoIds: ['kJQP7kiw5Fk'],
        status: 'published',
        authorAccountId: null,
        publishedAt: 'Sept 18, 2026',
        createdAt: 'Sept 16, 2026'
      },
{
        id: 'seed-interview-3',
        title: 'Twelve Years Judging the Biggest Election in Nakuru',
        guest: 'Justice Wanjiru Kimutai',
        guestRole: 'Presiding Judge, Nakuru',
        interviewer: 'Grace Wanjiku',
        summary:
          'On running a county election office under a parallel-results dispute, and what the courts will and will not fix.',
        description:
          'Justice Wanjiru Kimutai has spent twelve years on the bench in Nakuru County, and the two years since the last general election are the longest of them by some distance.\n\nShe is careful about the parallel-results dispute, and deliberately imprecise about her own view of it: what she will say, at length, is that the administrative contest happens weeks before any court does, and that the losing side is almost never the party with the weakest argument.\n\n"We are asked to answer a narrow question. Was the tally done correctly. Not: should the result stand. A judge who confuses the two ends up making a political decision and calling it jurisprudence, and I would rather not."\n\nOn why she still does the work.',
        image:
          'https://images.unsplash.com/photo-1589578527966-fdac0f44566c?auto=format&fit=crop&w=1200&q=80',
        videoIds: ['3fumBcKC6RE', 'JGwWNGJdvx8'],
        status: 'published',
        authorAccountId: null,
        publishedAt: 'Sept 11, 2026',
        createdAt: 'Sept 9, 2026'
      },
      {
        // Deliberately NOT published. A demo load that shipped only live rows
        // would leave the Owner's approval queue permanently empty, which is
        // the one part of the feature a demo cannot otherwise demonstrate.
        id: 'seed-interview-4',
        title: 'The Last Print Shop on Moi Avenue',
        guest: 'Rashid Suleiman',
        guestRole: 'Printer, Suleiman Print Works',
        interviewer: 'Grace Wanjiku',
        summary:
          'Awaiting the Owner\'s review. On the machines that will not be replaced, and the apprentices nobody is training.',
        description:
          'Filed from Moi Avenue and awaiting review before publication.\n\nRashid Suleiman has run Suleiman Print Works since 1988. The shop still holds a Heidelberg press and two hand-fed platen presses that no manufacturer makes parts for any more.',
        image:
          'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80',
        videoIds: [],
        status: 'pending',
        authorAccountId: null,
        publishedAt: null,
        createdAt: 'Sept 25, 2026'
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

