// Centralized selectors tuned to your portal DOM
export const selectors = {
  login: {
    emailInput: [
      '#login_username',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[id*="email" i]'
    ],
    emailNextButton: [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Submit")'
    ],
    passwordInput: [
      '#login_password',
      'input[autocomplete="current-password"]',
      'input[type="password"]',
      'input[id*="password" i]'
    ],
    loginButton: [
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button:has-text("Login")',
      'button[type="submit"]'
    ]
  },

  // Events grid / cards (React SPA, loads 9 at a time as you scroll)
  eventsGrid: {
    card: ['.pv-card'],
    gridReadyProbe: ['.pv-card', 'main', 'body'],
    cardTitle: ['.pv-card h5[data-cy="Title"], .pv-card h5']
  },

  // Detail page fields (we still read date/time/location/banner/url here)
  eventDetail: {
    // <h1 data-cy="Title">...</h1>
    title: ['h1[data-cy="Title"]', 'h1', '[data-testid="event-title"]'],

    // <span data-cy="LocalFormattedDate">Aug 8, 2025</span>
    date: ['.pv-descriptions [data-cy="LocalFormattedDate"]', '[data-cy="LocalFormattedDate"]'],

    // Time & location are generic Text spans in the meta block
    timeCandidates: ['.pv-descriptions [data-cy="Text"]', '[data-cy="Text"]'],
    locationCandidates: ['.pv-descriptions [data-cy="Text"]', '[data-cy="Text"]'],

    // Banner <img class="pv-image-img" ...>
    bannerImg: ['img.pv-image-img', '[data-testid="event-hero"] img', 'header img', 'img'],

    // (Not used anymore—kept for reference)
    descriptionHtml: ['[data-cy="Markup"]', '.markup[data-cy="Markup"]', 'article'],

    // Return/back affordance
    backToEvents: [
      'a[href$="/events"]',
      'button:has-text("Back")',
      'nav a',
      'a:has-text("Events")'
    ]
  }
};

