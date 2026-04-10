/**
 * Navio Browser – Tool definitions for native API tool calling.
 *
 * Canonical, provider-neutral tool list + transforms for OpenAI, Anthropic, and
 * Google Gemini.  The tool loop in main.js imports these at startup and passes
 * them through the appropriate transform before each performAiFetch call.
 */

'use strict';

// ── Canonical tool definitions ───────────────────────────────────────────────
// Each entry: { name, description, parameters } where `parameters` is a
// JSON-Schema-style object (type "object", properties, required).

const NAVIO_TOOLS = [
  {
    name: 'navigate',
    description:
      'Navigate the active browser tab to a URL. Always use a full https:// URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to navigate to (must include https://)' }
      },
      required: ['url']
    }
  },
  {
    name: 'go_back',
    description: 'Go back one page in browser history.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'go_forward',
    description: 'Go forward one page in browser history.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'click',
    description:
      'Click an element on the page. Prefer "ref" (from read_page) for reliability. ' +
      'Fall back to "text" (visible label), "aria" (aria-label), or "xy" (viewport coordinates from a screenshot).',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Ref ID from the accessibility tree (e.g. "ref_5"). Preferred.'
        },
        text: {
          type: 'string',
          description: 'Visible text label of the element to click (fallback).'
        },
        aria: {
          type: 'string',
          description: 'aria-label of the element (fallback).'
        },
        xy: {
          type: 'string',
          description: 'Viewport coordinates "x,y" from a screenshot (last resort).'
        }
      }
    }
  },
  {
    name: 'type_text',
    description:
      'Type text into a form field. Identify the field by "ref" (preferred) or "text" (visible label/placeholder).',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Ref ID of the input field from read_page.'
        },
        text: {
          type: 'string',
          description: 'Visible label or placeholder of the field (fallback).'
        },
        value: {
          type: 'string',
          description: 'The text to type into the field.'
        }
      },
      required: ['value']
    }
  },
  {
    name: 'select_option',
    description:
      'Select an option from a native <select> dropdown. Identify the dropdown by "ref" or "text".',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Ref ID of the select element from read_page.'
        },
        text: {
          type: 'string',
          description: 'Visible label of the select element (fallback).'
        },
        value: {
          type: 'string',
          description: 'The option value or visible text to select.'
        }
      },
      required: ['value']
    }
  },
  {
    name: 'read_page',
    description:
      'Get an accessibility tree representation of the current page. Returns interactive elements ' +
      'with ref IDs you can use for click/type_text. Call this after every navigation or page change.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description:
            '"interactive" returns only buttons, links, inputs, etc. "all" includes headings, text, images. Default: "interactive".'
        },
        ref: {
          type: 'string',
          description: 'Scope the read to a subtree rooted at this ref ID.'
        },
        max_chars: {
          type: 'number',
          description: 'Max characters for the output. Default: 50000.'
        }
      }
    }
  },
  {
    name: 'get_page_text',
    description:
      'Extract the raw text content of the current page. Useful for reading articles, search results, or data.',
    parameters: {
      type: 'object',
      properties: {
        max_chars: {
          type: 'number',
          description: 'Max characters to return. Default: 20000.'
        }
      }
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Scroll direction.'
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll. Default: 600.'
        }
      },
      required: ['direction']
    }
  },
  {
    name: 'press_key',
    description:
      'Press a keyboard key. Common keys: Tab, Enter, Escape, Backspace, ArrowDown, ArrowUp.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name (e.g. "Tab", "Enter", "Escape").'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture a screenshot of the current viewport. Returns a base64-encoded image. ' +
      'Use when you need visual context or coordinate-based clicks.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'insert_text',
    description:
      'Paste text into the currently focused field via clipboard. Required for Google Docs/Sheets and other canvas editors where type_text does not work.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to paste. Supports markdown for Google Docs.'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'wait',
    description:
      'Pause execution. Either wait for a fixed duration or until specific text appears on the page.',
    parameters: {
      type: 'object',
      properties: {
        ms: {
          type: 'number',
          description: 'Milliseconds to wait (max 10000).'
        },
        text: {
          type: 'string',
          description: 'Wait until this text appears on the page (polls for up to 12 s).'
        }
      }
    }
  },

  // ── Tab management tools ────────────────────────────────────────────────────
  {
    name: 'open_tab',
    description:
      'Open a new browser tab and optionally navigate it to a URL. Returns the new tab\'s ID. ' +
      'Use this for parallel research across multiple sites.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to load in the new tab (optional — omit for a blank tab).'
        }
      }
    }
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by its tab ID.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: {
          type: 'string',
          description: 'The tab ID to close (from list_tabs or open_tab).'
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'switch_tab',
    description:
      'Switch the active browser tab. Subsequent actions (click, type, read_page, etc.) will target this tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: {
          type: 'string',
          description: 'The tab ID to switch to (from list_tabs or open_tab).'
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'list_tabs',
    description:
      'List all open browser tabs with their IDs, titles, and URLs. Use to find a specific tab before switching to it.',
    parameters: { type: 'object', properties: {} }
  },

  // ── Developer / inspection tools ────────────────────────────────────────────
  {
    name: 'read_console',
    description:
      'Read recent JavaScript console messages (errors, warnings, logs) from the current page. ' +
      'Essential for debugging web apps and understanding page errors.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['all', 'error', 'warning', 'log', 'info'],
          description: 'Filter by log level. Default: "all".'
        },
        limit: {
          type: 'number',
          description: 'Max number of messages to return. Default: 50.'
        }
      }
    }
  },
  {
    name: 'read_network',
    description:
      'Read recent network requests from the current page with URLs, status codes, methods, and timing. ' +
      'Useful for debugging API calls, checking for failed requests, and understanding page loading.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'failed', 'xhr', 'document', 'script', 'stylesheet', 'image'],
          description: 'Filter requests by type or status. "failed" = status >= 400 or network error. Default: "all".'
        },
        limit: {
          type: 'number',
          description: 'Max number of entries to return. Default: 30.'
        }
      }
    }
  },

  // ── Planning & workflow tools ───────────────────────────────────────────────
  {
    name: 'propose_plan',
    description:
      'Propose a multi-step plan for the user to approve before execution. Use this when a task ' +
      'requires 3+ steps across pages/tabs, or involves sensitive actions (purchases, form submissions, emails). ' +
      'The user will see the plan and can approve, edit, or cancel. After approval, execute the steps.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the plan (e.g. "Book flight to Tokyo").'
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step_number: { type: 'number', description: 'Step order (1, 2, 3...).' },
              action: { type: 'string', description: 'Brief description of what this step does.' },
              tool: { type: 'string', description: 'Primary tool to use (navigate, click, type_text, etc.).' },
              details: { type: 'string', description: 'Specific parameters or notes for this step.' }
            },
            required: ['step_number', 'action']
          },
          description: 'Ordered list of steps in the plan.'
        },
        estimated_time: {
          type: 'string',
          description: 'Estimated time to complete (e.g. "2-3 minutes").'
        },
        risks: {
          type: 'string',
          description: 'Any risks or sensitive actions in the plan the user should know about.'
        }
      },
      required: ['title', 'steps']
    }
  },
  {
    name: 'run_workflow',
    description:
      'Run a previously saved workflow by name. Workflows are recorded sequences of browser actions ' +
      'that can be replayed. Use list_workflows first to see available workflows.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the saved workflow to run.'
        }
      },
      required: ['name']
    }
  },

  // ── Gmail API tools ─────────────────────────────────────────────────────────
  {
    name: 'gmail_search',
    description:
      'Search Gmail for emails using Gmail search syntax. Returns message IDs, subjects, senders, ' +
      'dates, snippets, thread IDs, and label IDs. Use this instead of navigating to mail.google.com ' +
      'whenever you need to find or list emails. ' +
      'Common queries: "in:inbox after:YYYY/MM/DD" for today\'s inbox, ' +
      '"in:inbox is:unread" for unread, "from:someone@example.com" for a specific sender. ' +
      'Requires Google OAuth to be connected in Navio Settings.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Gmail search query string (same syntax as the Gmail search box). ' +
            'Examples: "in:inbox after:2026/04/10", "in:inbox is:unread", "subject:invoice".'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of emails to return. Default: 20, max: 50.'
        }
      },
      required: ['query']
    }
  },

  {
    name: 'gmail_send_draft',
    description: 'Send an existing Gmail draft by its draft ID. The draft must have been created by gmail_create_reply_draft. This actually sends the email — only call this when the user explicitly confirms they want to send.',
    parameters: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The Gmail draft ID to send (from gmail_create_reply_draft result).' }
      },
      required: ['draft_id']
    }
  },

  {
    name: 'gmail_delete_draft',
    description: 'Delete a Gmail draft by its draft ID. Used when the user discards a reply.',
    parameters: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The Gmail draft ID to delete.' }
      },
      required: ['draft_id']
    }
  },

  {
    name: 'gmail_create_reply_draft',
    description:
      'Create a reply draft for a Gmail message via the Gmail API. The draft is saved in Gmail Drafts ' +
      'and is NOT sent — the user reviews and sends it manually. ' +
      'Use this for every reply task instead of clicking Reply in the browser (Gmail iframes are unreliable). ' +
      'Requires Google OAuth connected with gmail.compose scope.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to reply to (from gmail_search results or connector context).'
        },
        body: {
          type: 'string',
          description: 'The plain-text body of the reply draft.'
        }
      },
      required: ['message_id', 'body']
    }
  }
];

// ── Provider transforms ──────────────────────────────────────────────────────

/**
 * OpenAI format:
 * [{ type: "function", function: { name, description, parameters } }]
 */
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

/**
 * Anthropic format:
 * [{ name, description, input_schema }]
 */
function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

/**
 * Gemini format — returns the array for the `tools` field:
 * [{ functionDeclarations: [{ name, description, parameters }] }]
 */
function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    }
  ];
}

module.exports = {
  NAVIO_TOOLS,
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools
};
