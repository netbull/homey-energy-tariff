'use strict';

module.exports = {
  // GET /settings - Get all settings
  async getSettings({ homey }) {
    return {
      currency: homey.settings.get('currency') || 'EUR',
      dayRate: homey.settings.get('dayRate') || 0.12,
      nightRate: homey.settings.get('nightRate') || 0.06,
      seasons: homey.settings.get('seasons') || []
    };
  },

  // PUT /settings - Save all settings
  async putSettings({ homey, body }) {
    if (body.currency !== undefined) {
      homey.settings.set('currency', body.currency);
    }
    if (body.dayRate !== undefined) {
      homey.settings.set('dayRate', body.dayRate);
    }
    if (body.nightRate !== undefined) {
      homey.settings.set('nightRate', body.nightRate);
    }
    if (body.seasons !== undefined) {
      homey.settings.set('seasons', body.seasons);
    }
    return { success: true };
  }
};