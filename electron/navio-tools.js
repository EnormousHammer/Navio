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
