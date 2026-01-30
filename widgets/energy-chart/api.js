'use strict';

module.exports = {
  async getChartData({ homey }) {
    return homey.app.getChartData();
  },
};
