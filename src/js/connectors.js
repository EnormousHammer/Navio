/**
 * Navio Browser - Connectors Hub
 *
 * Two-tier system inspired by Claude/Perplexity:
 *  1. "Connections" tab  — API-authenticated integrations the AI assistant can
 *     actually query (GitHub, Notion, Perplexity search, Linear).
 *     Connect once → AI uses them during conversations.
 *  2. "Quick Launch" tab — curated URL shortcuts (original behaviour).
 */

class ConnectorsManagerClass {
  constructor() {
    this.favorites = [];
    this.hubVisible = false;
    this.activeTab = 'connections'; // 'connections' | 'launch'

    // Which services have stored API keys OR OAuth tokens (populated on init)
    this.connectedIds = new Set();

    // OAuth provider status + config (populated on init)
    this.oauthStatus = {};   // providerId → { connected, email, name, avatar }
    this.oauthProviders = []; // array of provider config objects from main process

    // Map: serviceId → oauthProviderId
    this.serviceToOAuth = {
      gmail: 'google', gdrive: 'google', gcalendar: 'google',
      outlook: 'microsoft', onedrive: 'microsoft',
      dropbox: 'dropbox', slack: 'slack', github: 'github', notion: 'notion'
    };

    // ── Real API connectors — grouped by category ───────────────────────────
    // Each service has a token/key the user provides once.
    // The AI assistant can then query these services during conversations.
    this.integrationCategories = [
      { id: 'email',        name: 'Email',          icon: '✉' },
      { id: 'cloud',        name: 'Cloud Storage',  icon: '☁' },
      { id: 'communication',name: 'Communication',  icon: '💬' },
      { id: 'productivity', name: 'Productivity',   icon: '📋' },
      { id: 'development',  name: 'Development',    icon: '</>' },
      { id: 'ai-search',    name: 'AI & Search',    icon: '✦'  },
    ];

    // IMAP status — loaded on init (gmail, outlook)
    this.imapStatus = {};

    this.integrations = [
      // ── Email — IMAP (email + password, no tokens/OAuth) ─────────────────
      {
        id: 'gmail',
        name: 'Gmail',
        tagline: 'Read, search and draft emails',
        description: 'Connect Gmail with your email and password. Works in the background — no tab needs to be open. AI can search your inbox and create drafts directly.',
        icon: 'M',
        gradient: 'linear-gradient(135deg, #ea4335, #fbbc04)',
        connectionType: 'imap',
        imapServiceId: 'gmail',
        capabilities: ['Search inbox by sender, subject, keyword', 'Read email threads', 'Create drafts in your Drafts folder', 'Check unread count'],
        category: 'email'
      },
      {
        id: 'outlook',
        name: 'Outlook',
        tagline: 'Read, search and draft emails',
        description: 'Connect Outlook with your Microsoft email and password. Works in the background without any open tab. AI can search your inbox and create drafts.',
        icon: 'O',
        gradient: 'linear-gradient(135deg, #0078d4, #00bcf2)',
        connectionType: 'imap',
        imapServiceId: 'outlook',
        capabilities: ['Search inbox by sender, subject, keyword', 'Read email threads', 'Create drafts in your Drafts folder', 'Check unread count'],
        category: 'email'
      },

      // ── Cloud Storage ────────────────────────────────────────────────────
      {
        id: 'gdrive',
        name: 'Google Drive',
        tagline: 'Search files and documents',
        description: 'Connect Google Drive so the AI can find your files and documents. Ask "find the Q3 report" or "show recent spreadsheets."',
        icon: 'GD',
        gradient: 'linear-gradient(135deg, #4285f4, #34a853)',
        keyLabel: 'Google Access Token',
        keyPlaceholder: 'ya29.a0...',
        keyHint: 'Get a token from developers.google.com/oauthplayground — select Drive API (drive.readonly scope)',
        keyLink: 'https://developers.google.com/oauthplayground/',
        capabilities: ['Search files by name or content', 'Find Docs, Sheets, Slides', 'Locate recent files'],
        category: 'cloud'
      },
      {
        id: 'dropbox',
        name: 'Dropbox',
        tagline: 'Search files in your Dropbox',
        description: 'Connect Dropbox so the AI can search through your stored files and folders. Ask "find the presentation from last month" or "search for invoices."',
        icon: 'D',
        gradient: 'linear-gradient(135deg, #0061fe, #0090ff)',
        keyLabel: 'Access Token',
        keyPlaceholder: 'sl.u.A...',
        keyHint: 'Create an app at dropbox.com/developers/apps → generate an access token under "OAuth 2"',
        keyLink: 'https://www.dropbox.com/developers/apps',
        capabilities: ['Search files by name', 'Find documents and media', 'Browse folder structure'],
        category: 'cloud'
      },
      {
        id: 'onedrive',
        name: 'OneDrive',
        tagline: 'Search files in OneDrive',
        description: 'Connect OneDrive so the AI can search your Microsoft files and documents. Pairs well with Outlook for full Microsoft 365 coverage.',
        icon: 'OD',
        gradient: 'linear-gradient(135deg, #0078d4, #28a8ea)',
        keyLabel: 'Microsoft Graph Access Token',
        keyPlaceholder: 'eyJ0eXAi...',
        keyHint: 'Get a token from developer.microsoft.com/en-us/graph/graph-explorer — sign in and copy the token',
        keyLink: 'https://developer.microsoft.com/en-us/graph/graph-explorer',
        capabilities: ['Search files and folders', 'Find Office documents', 'Locate recent files'],
        category: 'cloud'
      },

      // ── Communication ────────────────────────────────────────────────────
      {
        id: 'slack',
        name: 'Slack',
        tagline: 'Search messages across your workspace',
        description: 'Connect Slack so the AI can search your messages and channels. Ask "find conversations about the launch" or "search for messages from the design team."',
        icon: 'S',
        gradient: 'linear-gradient(135deg, #4a154b, #e01e5a)',
        keyLabel: 'User OAuth Token',
        keyPlaceholder: 'xoxp-...',
        keyHint: 'Create a Slack app at api.slack.com/apps → OAuth & Permissions → install and copy the User Token (xoxp-)',
        keyLink: 'https://api.slack.com/apps',
        capabilities: ['Search messages across all channels', 'Find conversations by topic', 'Search by user or channel'],
        category: 'communication'
      },

      // ── Productivity ─────────────────────────────────────────────────────
      {
        id: 'gcalendar',
        name: 'Google Calendar',
        tagline: 'Find events and upcoming meetings',
        description: 'Connect Google Calendar so the AI knows your schedule. Ask "what meetings do I have this week?" or "find events about the product review."',
        icon: 'GC',
        gradient: 'linear-gradient(135deg, #4285f4, #7baaf7)',
        keyLabel: 'Google Access Token',
        keyPlaceholder: 'ya29.a0...',
        keyHint: 'Get a token from developers.google.com/oauthplayground — select Calendar API (calendar.readonly scope)',
        keyLink: 'https://developers.google.com/oauthplayground/',
        capabilities: ['Search upcoming events', 'Find meetings by title or attendee', 'View next 30 days of schedule'],
        category: 'productivity'
      },
      {
        id: 'notion',
        name: 'Notion',
        tagline: 'Search across your pages and databases',
        description: 'Connect your Notion workspace so the AI can search your pages, databases, and notes. Ask "find the Q3 roadmap" or "what did we decide about the API design?"',
        icon: 'N',
        gradient: 'linear-gradient(135deg, #2f2f2f, #4a4a4a)',
        keyLabel: 'Integration Token',
        keyPlaceholder: 'secret_...',
        keyHint: 'Create an integration at notion.so/my-integrations → copy the token → share pages with the integration',
        keyLink: 'https://www.notion.so/my-integrations',
        capabilities: ['Search pages & databases', 'Find notes and docs', 'Retrieve meeting notes'],
        category: 'productivity'
      },
      {
        id: 'linear',
        name: 'Linear',
        tagline: 'Search issues and project updates',
        description: 'Connect Linear so the AI can search your issues and projects. Ask "what high-priority bugs are open?" or "show issues assigned to me."',
        icon: 'Li',
        gradient: 'linear-gradient(135deg, #5e6ad2, #8b95e8)',
        keyLabel: 'API Key',
        keyPlaceholder: 'lin_api_...',
        keyHint: 'Go to linear.app/settings/api → Personal API keys → create and copy',
        keyLink: 'https://linear.app/settings/api',
        capabilities: ['Search issues by keyword', 'Filter by team / state', 'Track priorities'],
        category: 'productivity'
      },

      // ── Development ──────────────────────────────────────────────────────
      {
        id: 'github',
        name: 'GitHub',
        tagline: 'Search issues, PRs, and repositories',
        description: 'Connect GitHub so the AI can search across your repositories. Ask "find open authentication bugs" or "show PRs waiting for review."',
        icon: 'GH',
        gradient: 'linear-gradient(135deg, #24292f, #444d56)',
        keyLabel: 'Personal Access Token',
        keyPlaceholder: 'ghp_... or github_pat_...',
        keyHint: 'Go to github.com/settings/tokens → generate a classic or fine-grained token with repo + read:org scopes',
        keyLink: 'https://github.com/settings/tokens',
        capabilities: ['Search issues & pull requests', 'Search code', 'Find repositories'],
        category: 'development'
      },

      // ── AI & Search ──────────────────────────────────────────────────────
      {
        id: 'perplexity',
        name: 'Perplexity',
        tagline: 'Live web search with cited answers',
        description: 'Connect Perplexity\'s Sonar API to give the AI real-time web search. Ask about current events, news, or anything that needs up-to-date information.',
        icon: 'Px',
        gradient: 'linear-gradient(135deg, #1a9688, #20b8a2)',
        keyLabel: 'API Key',
        keyPlaceholder: 'pplx-...',
        keyHint: 'Go to perplexity.ai/settings/api → generate an API key',
        keyLink: 'https://www.perplexity.ai/settings/api',
        capabilities: ['Real-time web search', 'Answers with source citations', 'Current events & news'],
        category: 'ai-search'
      }
    ];

    // Services that support the Live Connector system
    this.liveCapableIds = new Set([
      'gmail', 'outlook', 'slack', 'discord', 'teams',
      'github', 'google-calendar', 'notion'
    ]);

    // ── Quick Launch service catalog ────────────────────────────────────────
    this.services = [
      // ─── Email ───
      { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com', category: 'email', icon: 'M', color: '#ea4335', gradient: 'linear-gradient(135deg, #ea4335, #fbbc04)' },
      { id: 'outlook', name: 'Outlook', url: 'https://outlook.live.com/mail/', category: 'email', icon: 'O', color: '#0078d4', gradient: 'linear-gradient(135deg, #0078d4, #00bcf2)' },
      { id: 'yahoo-mail', name: 'Yahoo Mail', url: 'https://mail.yahoo.com', category: 'email', icon: 'Y', color: '#6001d2', gradient: 'linear-gradient(135deg, #6001d2, #a855f7)' },
      { id: 'protonmail', name: 'ProtonMail', url: 'https://mail.proton.me', category: 'email', icon: 'P', color: '#6d4aff', gradient: 'linear-gradient(135deg, #6d4aff, #8b6cff)' },
      { id: 'icloud-mail', name: 'iCloud Mail', url: 'https://www.icloud.com/mail', category: 'email', icon: 'iC', color: '#007aff', gradient: 'linear-gradient(135deg, #007aff, #5ac8fa)' },
      { id: 'zoho-mail', name: 'Zoho Mail', url: 'https://mail.zoho.com', category: 'email', icon: 'Z', color: '#f9a825', gradient: 'linear-gradient(135deg, #e65100, #f9a825)' },
      { id: 'tutanota', name: 'Tuta', url: 'https://app.tuta.com', category: 'email', icon: 'T', color: '#840010', gradient: 'linear-gradient(135deg, #840010, #c62828)' },
      { id: 'fastmail', name: 'Fastmail', url: 'https://app.fastmail.com', category: 'email', icon: 'F', color: '#69a3ca', gradient: 'linear-gradient(135deg, #3d7fa5, #69a3ca)' },

      // ─── Cloud Storage ───
      { id: 'gdrive', name: 'Google Drive', url: 'https://drive.google.com', category: 'cloud', icon: 'GD', color: '#4285f4', gradient: 'linear-gradient(135deg, #4285f4, #34a853)' },
      { id: 'dropbox', name: 'Dropbox', url: 'https://www.dropbox.com/home', category: 'cloud', icon: 'D', color: '#0061fe', gradient: 'linear-gradient(135deg, #0061fe, #0090ff)' },
      { id: 'onedrive', name: 'OneDrive', url: 'https://onedrive.live.com', category: 'cloud', icon: 'OD', color: '#0078d4', gradient: 'linear-gradient(135deg, #0078d4, #28a8ea)' },
      { id: 'icloud', name: 'iCloud Drive', url: 'https://www.icloud.com/iclouddrive', category: 'cloud', icon: 'iC', color: '#007aff', gradient: 'linear-gradient(135deg, #007aff, #5ac8fa)' },
      { id: 'box', name: 'Box', url: 'https://app.box.com', category: 'cloud', icon: 'B', color: '#0061d5', gradient: 'linear-gradient(135deg, #0061d5, #4da6ff)' },
      { id: 'mega', name: 'MEGA', url: 'https://mega.nz', category: 'cloud', icon: 'M', color: '#d9272e', gradient: 'linear-gradient(135deg, #d9272e, #ff6b6b)' },
      { id: 'pcloud', name: 'pCloud', url: 'https://my.pcloud.com', category: 'cloud', icon: 'pC', color: '#20b8a2', gradient: 'linear-gradient(135deg, #1a9688, #20b8a2)' },

      // ─── Productivity ───
      { id: 'notion', name: 'Notion', url: 'https://www.notion.so', category: 'productivity', icon: 'N', color: '#ffffff', gradient: 'linear-gradient(135deg, #333, #555)' },
      { id: 'trello', name: 'Trello', url: 'https://trello.com', category: 'productivity', icon: 'Tr', color: '#0052cc', gradient: 'linear-gradient(135deg, #0052cc, #2684ff)' },
      { id: 'asana', name: 'Asana', url: 'https://app.asana.com', category: 'productivity', icon: 'A', color: '#f06a6a', gradient: 'linear-gradient(135deg, #f06a6a, #ff9a9e)' },
      { id: 'todoist', name: 'Todoist', url: 'https://todoist.com/app', category: 'productivity', icon: 'Td', color: '#e44332', gradient: 'linear-gradient(135deg, #e44332, #ff6b6b)' },
      { id: 'monday', name: 'Monday.com', url: 'https://monday.com', category: 'productivity', icon: 'Mo', color: '#ff3d57', gradient: 'linear-gradient(135deg, #ff3d57, #ffcb00)' },
      { id: 'clickup', name: 'ClickUp', url: 'https://app.clickup.com', category: 'productivity', icon: 'CU', color: '#7b68ee', gradient: 'linear-gradient(135deg, #7b68ee, #49ccf9)' },
      { id: 'jira', name: 'Jira', url: 'https://www.atlassian.com/software/jira', category: 'productivity', icon: 'J', color: '#0052cc', gradient: 'linear-gradient(135deg, #0052cc, #2684ff)' },
      { id: 'linear', name: 'Linear', url: 'https://linear.app', category: 'productivity', icon: 'Li', color: '#5e6ad2', gradient: 'linear-gradient(135deg, #5e6ad2, #8b95e8)' },
      { id: 'google-calendar', name: 'Google Calendar', url: 'https://calendar.google.com', category: 'productivity', icon: 'GC', color: '#4285f4', gradient: 'linear-gradient(135deg, #4285f4, #7baaf7)' },
      { id: 'google-docs', name: 'Google Docs', url: 'https://docs.google.com', category: 'productivity', icon: 'Dc', color: '#4285f4', gradient: 'linear-gradient(135deg, #4285f4, #7baaf7)' },
      { id: 'google-sheets', name: 'Google Sheets', url: 'https://sheets.google.com', category: 'productivity', icon: 'Sh', color: '#34a853', gradient: 'linear-gradient(135deg, #34a853, #57c97a)' },
      { id: 'evernote', name: 'Evernote', url: 'https://www.evernote.com/client/web', category: 'productivity', icon: 'E', color: '#00a82d', gradient: 'linear-gradient(135deg, #00a82d, #4cd964)' },
      { id: 'airtable', name: 'Airtable', url: 'https://airtable.com', category: 'productivity', icon: 'At', color: '#fcb400', gradient: 'linear-gradient(135deg, #2d7ff9, #18bfff)' },

      // ─── Communication ───
      { id: 'slack', name: 'Slack', url: 'https://app.slack.com', category: 'communication', icon: 'S', color: '#4a154b', gradient: 'linear-gradient(135deg, #4a154b, #e01e5a)' },
      { id: 'discord', name: 'Discord', url: 'https://discord.com/app', category: 'communication', icon: 'Ds', color: '#5865f2', gradient: 'linear-gradient(135deg, #5865f2, #8b95f2)' },
      { id: 'teams', name: 'Microsoft Teams', url: 'https://teams.microsoft.com', category: 'communication', icon: 'T', color: '#6264a7', gradient: 'linear-gradient(135deg, #6264a7, #8b8cc7)' },
      { id: 'zoom', name: 'Zoom', url: 'https://app.zoom.us', category: 'communication', icon: 'Zm', color: '#0b5cff', gradient: 'linear-gradient(135deg, #0b5cff, #4da6ff)' },
      { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org', category: 'communication', icon: 'Tg', color: '#0088cc', gradient: 'linear-gradient(135deg, #0088cc, #33bbff)' },
      { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', category: 'communication', icon: 'W', color: '#25d366', gradient: 'linear-gradient(135deg, #128c7e, #25d366)' },
      { id: 'signal', name: 'Signal', url: 'https://signal.org', category: 'communication', icon: 'Sg', color: '#3a76f0', gradient: 'linear-gradient(135deg, #2c6bed, #3a76f0)' },
      { id: 'google-meet', name: 'Google Meet', url: 'https://meet.google.com', category: 'communication', icon: 'GM', color: '#00897b', gradient: 'linear-gradient(135deg, #00897b, #4db6ac)' },

      // ─── Social ───
      { id: 'twitter', name: 'X / Twitter', url: 'https://twitter.com', category: 'social', icon: 'X', color: '#1da1f2', gradient: 'linear-gradient(135deg, #1a1a2e, #333)' },
      { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com', category: 'social', icon: 'in', color: '#0a66c2', gradient: 'linear-gradient(135deg, #0a66c2, #0077b5)' },
      { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com', category: 'social', icon: 'f', color: '#1877f2', gradient: 'linear-gradient(135deg, #1877f2, #4da6ff)' },
      { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com', category: 'social', icon: 'Ig', color: '#e4405f', gradient: 'linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)' },
      { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com', category: 'social', icon: 'R', color: '#ff4500', gradient: 'linear-gradient(135deg, #ff4500, #ff6a33)' },
      { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', category: 'social', icon: 'YT', color: '#ff0000', gradient: 'linear-gradient(135deg, #ff0000, #cc0000)' },
      { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com', category: 'social', icon: 'Tk', color: '#000000', gradient: 'linear-gradient(135deg, #25f4ee, #fe2c55)' },
      { id: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com', category: 'social', icon: 'P', color: '#e60023', gradient: 'linear-gradient(135deg, #e60023, #ff4d6a)' },
      { id: 'threads', name: 'Threads', url: 'https://www.threads.net', category: 'social', icon: '@', color: '#000000', gradient: 'linear-gradient(135deg, #333, #666)' },
      { id: 'mastodon', name: 'Mastodon', url: 'https://mastodon.social', category: 'social', icon: 'Ms', color: '#6364ff', gradient: 'linear-gradient(135deg, #6364ff, #858afa)' },

      // ─── Development ───
      { id: 'github', name: 'GitHub', url: 'https://github.com', category: 'development', icon: 'GH', color: '#ffffff', gradient: 'linear-gradient(135deg, #333, #555)' },
      { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com', category: 'development', icon: 'GL', color: '#fc6d26', gradient: 'linear-gradient(135deg, #fc6d26, #fdb251)' },
      { id: 'bitbucket', name: 'Bitbucket', url: 'https://bitbucket.org', category: 'development', icon: 'BB', color: '#0052cc', gradient: 'linear-gradient(135deg, #0052cc, #2684ff)' },
      { id: 'stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com', category: 'development', icon: 'SO', color: '#f48024', gradient: 'linear-gradient(135deg, #f48024, #ffbb66)' },
      { id: 'codepen', name: 'CodePen', url: 'https://codepen.io', category: 'development', icon: 'CP', color: '#ffffff', gradient: 'linear-gradient(135deg, #1a1a2e, #444)' },
      { id: 'vercel', name: 'Vercel', url: 'https://vercel.com/dashboard', category: 'development', icon: 'V', color: '#ffffff', gradient: 'linear-gradient(135deg, #000, #333)' },
      { id: 'netlify', name: 'Netlify', url: 'https://app.netlify.com', category: 'development', icon: 'Nt', color: '#00c7b7', gradient: 'linear-gradient(135deg, #014847, #00c7b7)' },
      { id: 'npm', name: 'npm', url: 'https://www.npmjs.com', category: 'development', icon: 'npm', color: '#cb3837', gradient: 'linear-gradient(135deg, #cb3837, #ff6b6b)' },
      { id: 'docker-hub', name: 'Docker Hub', url: 'https://hub.docker.com', category: 'development', icon: 'Dk', color: '#2496ed', gradient: 'linear-gradient(135deg, #2496ed, #66b8ff)' },

      // ─── AI & Tools ───
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chat.openai.com', category: 'ai', icon: 'AI', color: '#10a37f', gradient: 'linear-gradient(135deg, #10a37f, #1ed6a8)' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai', category: 'ai', icon: 'Cl', color: '#d4a574', gradient: 'linear-gradient(135deg, #c5956b, #d4a574)' },
      { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com', category: 'ai', icon: 'Ge', color: '#4285f4', gradient: 'linear-gradient(135deg, #4285f4, #a855f7)' },
      { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai', category: 'ai', icon: 'Px', color: '#20b8a2', gradient: 'linear-gradient(135deg, #1a9688, #20b8a2)' },
      { id: 'midjourney', name: 'Midjourney', url: 'https://www.midjourney.com', category: 'ai', icon: 'MJ', color: '#ffffff', gradient: 'linear-gradient(135deg, #1a1a2e, #333)' },
      { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co', category: 'ai', icon: 'HF', color: '#ffcc00', gradient: 'linear-gradient(135deg, #ff9d00, #ffcc00)' },
      { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com', category: 'ai', icon: 'Co', color: '#0078d4', gradient: 'linear-gradient(135deg, #0078d4, #00bcf2)' },

      // ─── Finance ───
      { id: 'paypal', name: 'PayPal', url: 'https://www.paypal.com', category: 'finance', icon: 'PP', color: '#003087', gradient: 'linear-gradient(135deg, #003087, #009cde)' },
      { id: 'stripe', name: 'Stripe', url: 'https://dashboard.stripe.com', category: 'finance', icon: 'St', color: '#635bff', gradient: 'linear-gradient(135deg, #635bff, #8b85ff)' },
      { id: 'wise', name: 'Wise', url: 'https://wise.com', category: 'finance', icon: 'Wi', color: '#9fe870', gradient: 'linear-gradient(135deg, #163300, #9fe870)' },
      { id: 'revolut', name: 'Revolut', url: 'https://app.revolut.com', category: 'finance', icon: 'Rv', color: '#0075eb', gradient: 'linear-gradient(135deg, #191c20, #0075eb)' },

      // ─── Design ───
      { id: 'figma', name: 'Figma', url: 'https://www.figma.com', category: 'design', icon: 'Fi', color: '#f24e1e', gradient: 'linear-gradient(135deg, #f24e1e, #a259ff)' },
      { id: 'canva', name: 'Canva', url: 'https://www.canva.com', category: 'design', icon: 'Ca', color: '#00c4cc', gradient: 'linear-gradient(135deg, #7b2ff7, #00c4cc)' },
      { id: 'dribbble', name: 'Dribbble', url: 'https://dribbble.com', category: 'design', icon: 'Dr', color: '#ea4c89', gradient: 'linear-gradient(135deg, #ea4c89, #f472b6)' },
      { id: 'behance', name: 'Behance', url: 'https://www.behance.net', category: 'design', icon: 'Be', color: '#1769ff', gradient: 'linear-gradient(135deg, #1769ff, #4da6ff)' },
    ];

    this.categories = [
      { id: 'email', name: 'Email', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>' },
      { id: 'cloud', name: 'Cloud Storage', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>' },
      { id: 'productivity', name: 'Productivity', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' },
      { id: 'communication', name: 'Communication', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
      { id: 'social', name: 'Social Media', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2h4v4"/><path d="M3 22l19-19"/><path d="M15 22v-6a3 3 0 0 0-3-3H6"/><path d="M3 18v4h4"/></svg>' },
      { id: 'development', name: 'Development', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
      { id: 'ai', name: 'AI & Tools', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7v1a7 7 0 0 1-14 0V9a7 7 0 0 1 7-7z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>' },
      { id: 'finance', name: 'Finance', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
      { id: 'design', name: 'Design', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M17.5 10.5 21 3"/><path d="M3 21l7.5-7.5"/><path d="M12.5 12.5 21 21"/><path d="M3 3l7 7"/></svg>' }
    ];

    this.init();
  }

  async init() {
    try {
      const config = await window.navio.getConfig();
      this.favorites = config.connectorFavorites || ['gmail', 'gdrive', 'dropbox', 'slack', 'notion', 'github', 'chatgpt'];
    } catch (e) {
      this.favorites = ['gmail', 'gdrive', 'dropbox', 'slack', 'notion', 'github', 'chatgpt'];
    }

    // Load OAuth status and provider configs (for "Sign in with Google" buttons)
    try {
      const [oauthSt, oauthProv] = await Promise.all([
        window.navio.oauthStatus(),
        window.navio.oauthProvidersConfig()
      ]);
      this.oauthStatus = oauthSt || {};
      this.oauthProviders = oauthProv || [];
    } catch {}

    // Load IMAP connection status (gmail, outlook)
    try {
      this.imapStatus = await window.navio.imapStatus() || {};
    } catch {}

    try {
      const keys = await window.navio.connectorGetKeys();
      this.connectedIds = new Set(Object.keys(keys).filter((k) => keys[k]));
    } catch (e) {
      this.connectedIds = new Set();
    }

    this.renderSidebarPins();
    this.bindEvents();
  }

  async _refreshOAuthState() {
    try {
      const [oauthSt, imapSt, keys] = await Promise.all([
        window.navio.oauthStatus(),
        window.navio.imapStatus(),
        window.navio.connectorGetKeys()
      ]);
      this.oauthStatus = oauthSt || {};
      this.imapStatus = imapSt || {};
      this.connectedIds = new Set(Object.keys(keys).filter((k) => keys[k]));
    } catch {}
  }

  bindEvents() {
    const btnMini = document.getElementById('btn-connectors');
    if (btnMini) btnMini.addEventListener('click', () => this.toggleHub());
    document.getElementById('btn-connectors-full').addEventListener('click', () => this.toggleHub());
    document.getElementById('connectors-hub-close').addEventListener('click', () => this.hideHub());

    const hubOverlay = document.getElementById('connectors-hub');
    hubOverlay.addEventListener('click', (e) => {
      if (e.target === hubOverlay) this.hideHub();
    });

    document.getElementById('connectors-search').addEventListener('input', (e) => {
      this.filterServices(e.target.value.trim());
    });

    document.getElementById('connectors-search').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (e.target.value) {
          e.target.value = '';
          this.filterServices('');
        } else {
          this.hideHub();
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.hubVisible) {
        this.hideHub();
      }
    });

    // Tab switching
    document.getElementById('connectors-tab-connections').addEventListener('click', () => {
      this.switchTab('connections');
    });
    document.getElementById('connectors-tab-launch').addEventListener('click', () => {
      this.switchTab('launch');
    });

    // Category buttons (for Quick Launch tab)
    document.querySelectorAll('.connector-cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.connector-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filterByCategory(btn.dataset.category);
      });
    });
  }

  switchTab(tab) {
    this.activeTab = tab;
    document.getElementById('connectors-tab-connections').classList.toggle('active', tab === 'connections');
    document.getElementById('connectors-tab-launch').classList.toggle('active', tab === 'launch');

    const searchRow = document.getElementById('connectors-hub-search-row');
    const categories = document.querySelector('.connectors-hub-categories');

    if (tab === 'connections') {
      if (searchRow) searchRow.style.display = 'none';
      if (categories) categories.style.display = 'none';
      this.renderConnectionsTab();
    } else {
      if (searchRow) searchRow.style.display = '';
      if (categories) categories.style.display = '';
      document.getElementById('connectors-search').value = '';
      this.renderHubServices();
    }
  }

  toggleHub() {
    if (this.hubVisible) {
      this.hideHub();
    } else {
      this.showHub();
    }
  }

  showHub() {
    this.hubVisible = true;
    const hub = document.getElementById('connectors-hub');
    hub.classList.add('active');

    // Default to Connections tab if no services connected yet; else respect last tab
    this.switchTab(this.activeTab);

    setTimeout(() => {
      if (this.activeTab === 'launch') {
        document.getElementById('connectors-search').focus();
      }
    }, 200);
  }

  hideHub() {
    this.hubVisible = false;
    document.getElementById('connectors-hub').classList.remove('active');
    document.getElementById('connectors-search').value = '';
  }

  // ── Connections Tab ───────────────────────────────────────────────────────

  renderConnectionsTab() {
    const container = document.getElementById('connectors-grid');
    const connected = this.integrations.filter((i) => this.connectedIds.has(i.id));
    const available = this.integrations.filter((i) => !this.connectedIds.has(i.id));

    let html = '';

    // Active connections first
    if (connected.length > 0) {
      html += `
        <div class="conn-section-header">
          <span class="conn-section-dot conn-section-dot--active"></span>
          Active connections
          <span class="conn-section-count">${connected.length}</span>
        </div>
        <div class="conn-integration-list">
      `;
      for (const intg of connected) {
        html += this._integrationCardHTML(intg, true);
      }
      html += '</div>';
    }

    // Available integrations grouped by category
    if (available.length > 0) {
      html += `<div class="conn-section-header" style="margin-top: ${connected.length > 0 ? '28px' : '0'}">
        <span class="conn-section-dot"></span>
        Available integrations
        <span class="conn-section-count">${available.length}</span>
      </div>`;

      for (const cat of this.integrationCategories) {
        const catItems = available.filter((i) => i.category === cat.id);
        if (!catItems.length) continue;
        html += `
          <div class="conn-category-row">
            <div class="conn-category-label">
              <span class="conn-cat-icon">${cat.icon}</span>
              ${cat.name}
            </div>
            <div class="conn-integration-list">
        `;
        for (const intg of catItems) {
          html += this._integrationCardHTML(intg, false);
        }
        html += '</div></div>';
      }
    }

    html += `
      <div class="conn-coming-soon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
        More integrations coming soon — Jira, Airtable, HubSpot, and more.
      </div>
    `;

    container.innerHTML = html;
    this._bindConnectionCards(container);
  }

  _oauthProviderFor(serviceId) {
    const pid = this.serviceToOAuth[serviceId];
    if (!pid) return null;
    return this.oauthProviders.find((p) => p.id === pid) || null;
  }

  _integrationCardHTML(intg, isConnected) {
    const capsHTML = intg.capabilities
      .map((c) => `<span class="conn-cap-pill">${c}</span>`)
      .join('');

    const isImap = intg.connectionType === 'imap';
    const imapEntry = isImap ? this.imapStatus[intg.imapServiceId] : null;
    const oauthProvider = !isImap ? this._oauthProviderFor(intg.id) : null;
    const oauthEntry = oauthProvider ? this.oauthStatus[oauthProvider.id] : null;
    const isOAuth = !!oauthProvider;

    if (isConnected) {
      // Show connected account email (IMAP or OAuth)
      const connectedEmail = isImap ? imapEntry?.email : oauthEntry?.email;
      let accountBadge = '';
      if (connectedEmail) {
        const avatarHtml = oauthEntry?.avatar
          ? `<img class="conn-oauth-avatar" src="${oauthEntry.avatar}" alt="">`
          : `<span class="conn-oauth-avatar-initials">${connectedEmail[0].toUpperCase()}</span>`;
        accountBadge = `
          <div class="conn-oauth-account">
            ${avatarHtml}
            <span class="conn-oauth-email">${connectedEmail}</span>
          </div>`;
      }

      const disconnectTarget = isImap ? intg.imapServiceId : (isOAuth ? oauthProvider.id : intg.id);
      const disconnectType = isImap ? 'imap' : (isOAuth ? 'oauth' : 'key');

      return `
        <div class="conn-integration-card conn-integration-card--connected" data-id="${intg.id}">
          <div class="conn-intg-icon" style="background: ${intg.gradient}">
            <span>${intg.icon}</span>
          </div>
          <div class="conn-intg-body">
            <div class="conn-intg-top">
              <span class="conn-intg-name">${intg.name}</span>
              <span class="conn-connected-badge">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                Connected
              </span>
            </div>
            ${accountBadge}
            <p class="conn-intg-tagline">${intg.tagline}</p>
            <div class="conn-caps">${capsHTML}</div>
          </div>
          <button class="conn-disconnect-btn" data-id="${disconnectTarget}" data-type="${disconnectType}" title="Disconnect">
            Disconnect
          </button>
        </div>
      `;
    }

    // Not connected — IMAP: show email + password form
    if (isImap) {
      return `
        <div class="conn-integration-card" data-id="${intg.id}">
          <div class="conn-intg-icon" style="background: ${intg.gradient}">
            <span>${intg.icon}</span>
          </div>
          <div class="conn-intg-body">
            <div class="conn-intg-top">
              <span class="conn-intg-name">${intg.name}</span>
            </div>
            <p class="conn-intg-tagline">${intg.tagline}</p>
            <p class="conn-intg-desc">${intg.description}</p>
            <div class="conn-caps">${capsHTML}</div>
          </div>
          <button class="conn-imap-connect-btn" data-id="${intg.id}" data-imap="${intg.imapServiceId}">
            Connect ${intg.name}
          </button>
        </div>
      `;
    }

    // Not connected — show the right connect button (OAuth)
    if (isOAuth) {
      const p = oauthProvider;
      const hasClientId = p.hasClientId;
      const btnStyle = `background:${p.buttonColor};color:${p.buttonTextColor};${p.buttonBorder ? `border:${p.buttonBorder};` : 'border:none;'}`;

      return `
        <div class="conn-integration-card" data-id="${intg.id}">
          <div class="conn-intg-icon" style="background: ${intg.gradient}">
            <span>${intg.icon}</span>
          </div>
          <div class="conn-intg-body">
            <div class="conn-intg-top">
              <span class="conn-intg-name">${intg.name}</span>
            </div>
            <p class="conn-intg-tagline">${intg.tagline}</p>
            <p class="conn-intg-desc">${intg.description}</p>
            <div class="conn-caps">${capsHTML}</div>
          </div>
          ${hasClientId
            ? `<button class="conn-oauth-btn" data-provider="${p.id}" data-service="${intg.id}" style="${btnStyle}">
                 ${p.buttonLabel}
               </button>`
            : `<button class="conn-setup-btn" data-provider="${p.id}" title="Client ID not configured — click to set up">
                 ⚙ Setup required
               </button>`
          }
        </div>
      `;
    }

    // API-key service (Perplexity, Linear, etc.)
    return `
      <div class="conn-integration-card" data-id="${intg.id}">
        <div class="conn-intg-icon" style="background: ${intg.gradient}">
          <span>${intg.icon}</span>
        </div>
        <div class="conn-intg-body">
          <div class="conn-intg-top">
            <span class="conn-intg-name">${intg.name}</span>
          </div>
          <p class="conn-intg-tagline">${intg.tagline}</p>
          <p class="conn-intg-desc">${intg.description}</p>
          <div class="conn-caps">${capsHTML}</div>
        </div>
        <button class="conn-connect-btn" data-id="${intg.id}">Connect</button>
      </div>
    `;
  }

  _bindConnectionCards(container) {
    // IMAP "Connect Gmail/Outlook" — email + password form
    container.querySelectorAll('.conn-imap-connect-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openImapConnectModal(btn.dataset.id, btn.dataset.imap);
      });
    });

    // OAuth "Sign in with X" buttons
    container.querySelectorAll('.conn-oauth-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._handleOAuthConnect(btn.dataset.provider, btn.dataset.service, btn);
      });
    });

    // "Setup required" button → open Settings → Connected Apps
    container.querySelectorAll('.conn-setup-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideHub();
        this._openConnectedAppsSettings(btn.dataset.provider);
      });
    });

    // Legacy API-key connect button (Perplexity, Linear, etc.)
    container.querySelectorAll('.conn-connect-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openConnectModal(btn.dataset.id);
      });
    });

    container.querySelectorAll('.conn-disconnect-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { id, type } = btn.dataset;
        await this.disconnectService(id, type);
      });
    });
  }

  _openImapConnectModal(serviceId, imapServiceId) {
    const intg = this.integrations.find((i) => i.id === serviceId);
    if (!intg) return;
    document.getElementById('conn-modal-overlay')?.remove();

    const isGmail = imapServiceId === 'gmail';
    const overlay = document.createElement('div');
    overlay.id = 'conn-modal-overlay';
    overlay.className = 'conn-modal-overlay';
    overlay.innerHTML = `
      <div class="conn-modal" role="dialog" aria-modal="true">
        <div class="conn-modal-header">
          <div class="conn-modal-title-row">
            <div class="conn-modal-icon" style="background: ${intg.gradient}"><span>${intg.icon}</span></div>
            <div>
              <h2 class="conn-modal-title">Connect ${intg.name}</h2>
              <p class="conn-modal-subtitle">Works without any open tab — reads and drafts in the background</p>
            </div>
          </div>
          <button class="conn-modal-close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="conn-modal-body">
          <label class="conn-modal-label" for="imap-email-input">Email address</label>
          <input type="email" id="imap-email-input" class="conn-modal-input" placeholder="${isGmail ? 'you@gmail.com' : 'you@outlook.com'}" autocomplete="email">

          <label class="conn-modal-label" style="margin-top:12px" for="imap-pass-input">
            ${isGmail ? 'App Password' : 'Password'}
          </label>
          <div class="conn-modal-input-wrap">
            <input type="password" id="imap-pass-input" class="conn-modal-input" placeholder="${isGmail ? '16-character app password' : 'Your account password'}" autocomplete="current-password" spellcheck="false">
            <button class="conn-modal-toggle-vis" title="Show/hide">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>

          ${isGmail ? `
          <div class="conn-modal-hint-row" style="margin-top:8px">
            <p class="conn-modal-hint">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              Gmail requires an App Password (not your regular password). Takes 60 seconds to generate.
            </p>
            <a class="conn-modal-key-link" data-href="https://myaccount.google.com/apppasswords" href="#">
              Get App Password
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>` : ''}

          <div class="conn-modal-caps" style="margin-top:14px">
            <span class="conn-modal-caps-label">What the AI will be able to do:</span>
            <ul class="conn-modal-caps-list">
              ${intg.capabilities.map((c) => `<li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>${c}</li>`).join('')}
            </ul>
          </div>
          <div class="conn-modal-error" id="conn-modal-error" style="display:none"></div>
        </div>
        <div class="conn-modal-footer">
          <button class="conn-modal-cancel">Cancel</button>
          <button class="conn-modal-confirm" id="imap-connect-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            Connect ${intg.name}
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.conn-modal-close').addEventListener('click', close);
    overlay.querySelector('.conn-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelectorAll('.conn-modal-key-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.dataset.href;
        if (href && typeof TabManager !== 'undefined') { TabManager.createTab(href); close(); this.hideHub(); }
      });
    });

    const passInput = overlay.querySelector('#imap-pass-input');
    overlay.querySelector('.conn-modal-toggle-vis').addEventListener('click', () => {
      passInput.type = passInput.type === 'password' ? 'text' : 'password';
    });

    const connectBtn = overlay.querySelector('#imap-connect-btn');
    const errorEl = overlay.querySelector('#conn-modal-error');
    connectBtn.addEventListener('click', async () => {
      const email = overlay.querySelector('#imap-email-input').value.trim();
      const password = passInput.value;
      if (!email || !password) {
        errorEl.textContent = 'Please enter your email and password.';
        errorEl.style.display = 'flex';
        return;
      }
      connectBtn.disabled = true;
      connectBtn.innerHTML = `<svg class="conn-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Connecting…`;
      errorEl.style.display = 'none';
      try {
        const result = await window.navio.imapConnect(imapServiceId, email, password);
        if (result?.error) throw new Error(result.error);
        await this._refreshOAuthState();
        close();
        this.renderConnectionsTab();
        this.renderSidebarPins();
      } catch (e) {
        // Show multiline error with line-break support
        const msg = e.message || 'Connection failed. Check your credentials.';
        errorEl.innerHTML = msg.replace(/\n/g, '<br>');
        errorEl.style.display = 'flex';
        connectBtn.disabled = false;
        connectBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg> Connect ${intg.name}`;
      }
    });

    setTimeout(() => overlay.querySelector('#imap-email-input').focus(), 100);
  }

  async _handleOAuthConnect(providerId, serviceId, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Connecting…';
    }
    try {
      const result = await window.navio.oauthConnect(providerId);
      if (result?.needsClientId) {
        this._openConnectedAppsSettings(providerId);
        return;
      }
      if (result?.error) {
        // Don't alert on user-cancelled (they closed the window)
        if (!result.error.includes('closed by user')) {
          this._showConnectError(serviceId, result.error);
        }
        return;
      }
      // Success — refresh state and re-render
      await this._refreshOAuthState();
      this.renderConnectionsTab();
      this.renderSidebarPins();
    } catch (e) {
      this._showConnectError(serviceId, e.message);
    } finally {
      if (btn && !btn.closest('.conn-integration-card--connected')) {
        btn.disabled = false;
        // Re-render will have replaced btn so no need to reset text
      }
    }
  }

  _showConnectError(serviceId, message) {
    const card = document.querySelector(`.conn-integration-card[data-id="${serviceId}"]`);
    if (!card) return;
    let err = card.querySelector('.conn-card-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'conn-card-error';
      card.appendChild(err);
    }
    err.textContent = message;
    setTimeout(() => err?.remove(), 6000);
  }

  _openConnectedAppsSettings(providerId) {
    // Open the Settings panel and navigate to "Connected Apps" section
    const settingsBtn = document.getElementById('btn-settings') || document.querySelector('[data-action="settings"]');
    if (settingsBtn) settingsBtn.click();
    setTimeout(() => {
      const section = document.getElementById('settings-connected-apps');
      if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
        // Flash highlight
        section.classList.add('settings-highlight');
        setTimeout(() => section.classList.remove('settings-highlight'), 2000);
      }
    }, 300);
  }

  // ── Connect Modal ─────────────────────────────────────────────────────────

  openConnectModal(serviceId) {
    const intg = this.integrations.find((i) => i.id === serviceId);
    if (!intg) return;

    // Remove any existing modal
    document.getElementById('conn-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'conn-modal-overlay';
    overlay.className = 'conn-modal-overlay';
    overlay.innerHTML = `
      <div class="conn-modal" role="dialog" aria-modal="true">
        <div class="conn-modal-header">
          <div class="conn-modal-title-row">
            <div class="conn-modal-icon" style="background: ${intg.gradient}">
              <span>${intg.icon}</span>
            </div>
            <div>
              <h2 class="conn-modal-title">Connect ${intg.name}</h2>
              <p class="conn-modal-subtitle">${intg.tagline}</p>
            </div>
          </div>
          <button class="conn-modal-close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="conn-modal-body">
          <p class="conn-modal-desc">${intg.description}</p>

          <label class="conn-modal-label" for="conn-modal-key-input">${intg.keyLabel}</label>
          <div class="conn-modal-input-wrap">
            <input
              type="password"
              id="conn-modal-key-input"
              class="conn-modal-input"
              placeholder="${intg.keyPlaceholder}"
              autocomplete="off"
              spellcheck="false"
            >
            <button class="conn-modal-toggle-vis" title="Show/hide key" aria-label="Toggle visibility">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="conn-modal-hint-row">
            <p class="conn-modal-hint">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              ${intg.keyHint}
            </p>
            ${intg.keyLink ? `<a class="conn-modal-key-link" href="${intg.keyLink}" target="_blank" data-href="${intg.keyLink}">
              Get token
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>` : ''}
          </div>

          <div class="conn-modal-caps">
            <span class="conn-modal-caps-label">What the AI will be able to do:</span>
            <ul class="conn-modal-caps-list">
              ${intg.capabilities.map((c) => `<li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>${c}</li>`).join('')}
            </ul>
          </div>

          <div class="conn-modal-error" id="conn-modal-error" style="display:none"></div>
        </div>

        <div class="conn-modal-footer">
          <button class="conn-modal-cancel">Cancel</button>
          <button class="conn-modal-confirm" data-id="${serviceId}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            Connect ${intg.name}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Bind modal events
    overlay.querySelector('.conn-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.conn-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // "Get token" link — open in a new tab inside Navio
    overlay.querySelectorAll('.conn-modal-key-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.dataset.href;
        if (href && typeof TabManager !== 'undefined') {
          TabManager.createTab(href);
          overlay.remove();
          this.hideHub();
        }
      });
    });

    const input = overlay.querySelector('#conn-modal-key-input');
    const toggleVis = overlay.querySelector('.conn-modal-toggle-vis');
    toggleVis.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('.conn-modal-confirm').click();
      if (e.key === 'Escape') overlay.remove();
    });

    overlay.querySelector('.conn-modal-confirm').addEventListener('click', async () => {
      await this.saveConnection(serviceId, input.value.trim(), overlay);
    });

    setTimeout(() => input.focus(), 100);
  }

  async saveConnection(serviceId, apiKey, modalEl) {
    const errorEl = modalEl.querySelector('#conn-modal-error');
    const confirmBtn = modalEl.querySelector('.conn-modal-confirm');

    if (!apiKey) {
      errorEl.textContent = 'Please enter an API key or token.';
      errorEl.style.display = 'flex';
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `
      <svg class="conn-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      Connecting...
    `;
    errorEl.style.display = 'none';

    try {
      const result = await window.navio.connectorSaveKey(serviceId, apiKey);
      if (result?.error) throw new Error(result.error);

      this.connectedIds.add(serviceId);
      modalEl.remove();
      this.renderConnectionsTab();
      this.renderSidebarPins();
    } catch (e) {
      errorEl.textContent = e.message || 'Failed to save key. Please try again.';
      errorEl.style.display = 'flex';
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        Connect ${serviceId}
      `;
    }
  }

  async disconnectService(id, type) {
    try {
      if (type === 'imap') {
        await window.navio.imapDisconnect(id);
      } else if (type === 'oauth') {
        await window.navio.oauthDisconnect(id);
      } else {
        await window.navio.connectorRemoveKey(id);
      }
      await this._refreshOAuthState();
      this.renderConnectionsTab();
      this.renderSidebarPins();
    } catch (e) {
      console.error('Failed to disconnect service:', e);
    }
  }

  // ── Quick Launch Tab (original behaviour) ────────────────────────────────

  renderHubServices(filteredServices = null) {
    const container = document.getElementById('connectors-grid');
    const servicesToRender = filteredServices || this.services;

    if (servicesToRender.length === 0) {
      container.innerHTML = `
        <div class="connectors-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <p>No services found</p>
        </div>
      `;
      return;
    }

    const grouped = {};
    servicesToRender.forEach(s => {
      if (!grouped[s.category]) grouped[s.category] = [];
      grouped[s.category].push(s);
    });

    let html = '';
    for (const cat of this.categories) {
      if (!grouped[cat.id]) continue;
      html += `
        <div class="connectors-category-group">
          <div class="connectors-category-label">
            ${cat.icon}
            <span>${cat.name}</span>
            <span class="cat-count">${grouped[cat.id].length}</span>
          </div>
          <div class="connectors-category-cards">
      `;
      for (const service of grouped[cat.id]) {
        const isFav = this.favorites.includes(service.id);
        const isLiveCapable = this.liveCapableIds.has(service.id);
        const isLive = isLiveCapable && typeof LiveConnectorManager !== 'undefined' && LiveConnectorManager.isEnabled(service.id);
        const liveMode = isLive && typeof LiveConnectorManager !== 'undefined' ? LiveConnectorManager.getMode(service.id) : '';
        const liveBadge = isLiveCapable
          ? `<div class="connector-live-badge ${isLive ? 'connector-live-badge--on' : ''}" data-service-id="${service.id}" title="${isLive ? `Live · ${liveMode} mode` : 'Enable live monitoring'}">
              <span class="connector-live-dot"></span>
              <span class="connector-live-label">${isLive ? 'LIVE' : 'Live'}</span>
             </div>`
          : '';
        const settingsBtn = isLiveCapable
          ? `<button class="connector-live-settings-btn" data-service-id="${service.id}" title="Live Connector settings">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
             </button>`
          : '';
        // Google sub-services return the generic "G" from the favicon service,
        // so we override with their specific product-icon URLs (gstatic CDN).
        const LOGO_OVERRIDES = {
          'mail.google.com':     'https://www.gstatic.com/images/icons/material/product/2x/gmail_48dp.png',
          'drive.google.com':    'https://www.gstatic.com/images/icons/material/product/2x/drive_48dp.png',
          'calendar.google.com': 'https://www.gstatic.com/images/icons/material/product/2x/calendar_48dp.png',
          'docs.google.com':     'https://www.gstatic.com/images/icons/material/product/2x/docs_48dp.png',
          'sheets.google.com':   'https://www.gstatic.com/images/icons/material/product/2x/sheets_48dp.png',
          'slides.google.com':   'https://www.gstatic.com/images/icons/material/product/2x/slides_48dp.png',
          'meet.google.com':     'https://www.gstatic.com/images/icons/material/product/2x/meet_48dp.png',
          'gemini.google.com':   'https://www.gstatic.com/images/icons/material/product/2x/assistant_48dp.png',
        };
        const _svcHostname = (() => { try { return new URL(service.url).hostname; } catch(e) { return ''; } })();
        const _svcFavicon = _svcHostname
          ? (LOGO_OVERRIDES[_svcHostname] || `https://www.google.com/s2/favicons?domain=${_svcHostname}&sz=64`)
          : '';
        html += `
          <div class="connector-card ${isLive ? 'connector-card--live' : ''}" data-service-id="${service.id}" title="${service.name} — ${service.url}">
            <div class="connector-card-icon" style="background: ${service.gradient}">
              ${_svcFavicon ? `<img src="${_svcFavicon}" alt="${service.name}" class="conn-svc-logo" onerror="this.remove()">` : `<span>${service.icon}</span>`}
            </div>
            <div class="connector-card-info">
              <span class="connector-card-name">${service.name}</span>
              ${liveBadge}
            </div>
            <div class="connector-card-actions">
              ${settingsBtn}
              <button class="connector-fav-btn ${isFav ? 'active' : ''}" data-service-id="${service.id}" title="${isFav ? 'Remove from sidebar' : 'Pin to sidebar'}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </button>
            </div>
          </div>
        `;
      }
      html += '</div></div>';
    }

    container.innerHTML = html;

    container.querySelectorAll('.connector-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.connector-fav-btn')) return;
        if (e.target.closest('.connector-live-settings-btn')) return;
        if (e.target.closest('.connector-live-badge')) return;
        const id = card.dataset.serviceId;
        this.openService(id);
      });
    });

    container.querySelectorAll('.connector-fav-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.serviceId;
        this.toggleFavorite(id);
        btn.classList.toggle('active');
        const isFav = this.favorites.includes(id);
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        btn.title = isFav ? 'Remove from sidebar' : 'Pin to sidebar';
      });
    });

    // Live badge — quick toggle
    container.querySelectorAll('.connector-live-badge').forEach((badge) => {
      badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = badge.dataset.serviceId;
        if (typeof LiveConnectorManager !== 'undefined') {
          await LiveConnectorManager.toggleLive(id);
          this.renderHubServices();
        }
      });
    });

    // Live settings gear
    container.querySelectorAll('.connector-live-settings-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.serviceId;
        if (typeof LiveConnectorManager !== 'undefined') {
          LiveConnectorManager.openSettings(id);
        }
      });
    });
  }

  // Called by LiveConnectorManager after toggling to refresh a single card's badge
  refreshLiveBadge(serviceId) {
    const card = document.querySelector(`.connector-card[data-service-id="${serviceId}"]`);
    if (!card) return;
    if (typeof LiveConnectorManager === 'undefined') return;
    const isLive = LiveConnectorManager.isEnabled(serviceId);
    const mode = LiveConnectorManager.getMode(serviceId);
    card.classList.toggle('connector-card--live', isLive);
    const badge = card.querySelector('.connector-live-badge');
    if (badge) {
      badge.classList.toggle('connector-live-badge--on', isLive);
      badge.title = isLive ? `Live · ${mode} mode` : 'Enable live monitoring';
      const label = badge.querySelector('.connector-live-label');
      if (label) label.textContent = isLive ? 'LIVE' : 'Live';
    }
  }

  filterServices(query) {
    if (!query) {
      document.querySelectorAll('.connector-cat-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.connector-cat-btn[data-category="all"]')?.classList.add('active');
      this.renderHubServices();
      return;
    }
    const lower = query.toLowerCase();
    const filtered = this.services.filter(s =>
      s.name.toLowerCase().includes(lower) ||
      s.category.toLowerCase().includes(lower) ||
      s.url.toLowerCase().includes(lower)
    );
    this.renderHubServices(filtered);
  }

  filterByCategory(catId) {
    if (catId === 'all') {
      this.renderHubServices();
    } else {
      const filtered = this.services.filter(s => s.category === catId);
      this.renderHubServices(filtered);
    }
  }

  openService(serviceId) {
    const service = this.services.find(s => s.id === serviceId);
    if (!service) return;
    this.hideHub();
    if (typeof TabManager !== 'undefined') {
      TabManager.createTab(service.url);
    }
  }

  async toggleFavorite(serviceId) {
    const index = this.favorites.indexOf(serviceId);
    if (index >= 0) {
      this.favorites.splice(index, 1);
    } else {
      this.favorites.push(serviceId);
    }
    this.renderSidebarPins();
    this.saveFavorites();
  }

  async saveFavorites() {
    try {
      const config = await window.navio.getConfig();
      config.connectorFavorites = this.favorites;
      await window.navio.saveConfig(config);
    } catch (e) {
      console.error('Failed to save connector favorites:', e);
    }
  }

  renderSidebarPins() {
    const container = document.getElementById('sidebar-connectors');
    if (!container) return;

    if (this.favorites.length === 0) {
      container.innerHTML = '<div class="sidebar-pin-empty">Pin services from the hub</div>';
      return;
    }

    let html = '';
    for (const favId of this.favorites) {
      const service = this.services.find(s => s.id === favId);
      if (!service) continue;
      html += `
        <div class="sidebar-pin" data-service-id="${service.id}" title="${service.name}">
          <div class="sidebar-pin-icon" style="background: ${service.gradient}">${service.icon}</div>
          <span class="sidebar-pin-name">${service.name}</span>
        </div>
      `;
    }
    container.innerHTML = html;

    container.querySelectorAll('.sidebar-pin').forEach((pin) => {
      pin.addEventListener('click', () => {
        this.openService(pin.dataset.serviceId);
      });
    });
  }

  // ── Public API for assistant integration ─────────────────────────────────

  getConnectedIntegrations() {
    return this.integrations.filter((i) => this.connectedIds.has(i.id));
  }

  isConnected(serviceId) {
    return this.connectedIds.has(serviceId);
  }

  async queryConnector(serviceId, query, options = {}) {
    return window.navio.connectorQuery(serviceId, query, options);
  }
}

const ConnectorsManager = new ConnectorsManagerClass();
