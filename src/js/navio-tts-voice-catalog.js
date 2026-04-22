'use strict';
/**
 * OpenAI speech API built-in voices (tts-1, tts-1-hd, gpt-4o-mini-tts).
 * Group labels are informal “how they’re often heard” — pick by ear in Settings.
 * @see https://platform.openai.com/docs/guides/text-to-speech
 */
(function (global) {
  const VOICES = {
    female: [
      { id: 'nova', label: 'Nova', hint: 'Warm, conversational' },
      { id: 'shimmer', label: 'Shimmer', hint: 'Bright, clear' },
      { id: 'coral', label: 'Coral', hint: 'Light, friendly' },
      { id: 'sage', label: 'Sage', hint: 'Calm, thoughtful' },
      { id: 'marin', label: 'Marin', hint: 'Natural (OpenAI picks for quality)' },
      { id: 'verse', label: 'Verse', hint: 'Upbeat, expressive' }
    ],
    male: [
      { id: 'onyx', label: 'Onyx', hint: 'Deep, confident' },
      { id: 'echo', label: 'Echo', hint: 'Smooth baritone' },
      { id: 'fable', label: 'Fable', hint: 'British storyteller' },
      { id: 'cedar', label: 'Cedar', hint: 'Grounded (OpenAI picks for quality)' },
      { id: 'ballad', label: 'Ballad', hint: 'Warm narrator' },
      { id: 'ash', label: 'Ash', hint: 'Steady, composed' }
    ],
    neutral: [{ id: 'alloy', label: 'Alloy', hint: 'Androgynous, versatile' }]
  };

  const ALL_IDS = new Set();
  for (const k of Object.keys(VOICES)) {
    for (const row of VOICES[k]) ALL_IDS.add(row.id);
  }

  const FEMALE_IDS = new Set(VOICES.female.map((r) => r.id));

  global.NAVIO_OPENAI_TTS_VOICES = VOICES;
  global.NAVIO_TTS_VOICE_IDS = ALL_IDS;

  global.navioNormalizeTtsVoiceId = function (id) {
    const s = String(id || '')
      .trim()
      .toLowerCase();
    if (ALL_IDS.has(s)) return s;
    return 'nova';
  };

  /** Web Speech fallback: prefer feminine system voices when these OpenAI ids are selected. */
  global.navioTtsVoiceFemalePreferred = function (id) {
    return FEMALE_IDS.has(
      String(id || '')
        .trim()
        .toLowerCase()
    );
  };

  /** Populate a select element with optgroups (Settings + full-page chat). */
  global.navioPopulateTtsVoiceSelect = function (selectEl, selectedId) {
    if (!selectEl || !VOICES) return;
    const norm = global.navioNormalizeTtsVoiceId(selectedId);
    const labels = { female: 'Often feminine', male: 'Often masculine', neutral: 'Neutral / flexible' };
    selectEl.innerHTML = '';
    for (const g of ['female', 'male', 'neutral']) {
      const og = document.createElement('optgroup');
      og.label = labels[g] || g;
      for (const row of VOICES[g] || []) {
        const o = document.createElement('option');
        o.value = row.id;
        o.textContent = `${row.label} — ${row.hint || ''}`;
        og.appendChild(o);
      }
      if (og.childNodes.length) selectEl.appendChild(og);
    }
    selectEl.value = norm;
  };
})(typeof window !== 'undefined' ? window : globalThis);
