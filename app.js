'use strict';

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');

class ElectricityTariffApp extends Homey.App {

  async onInit() {
    this.log('Electricity Tariff app has been initialized');

    // Initialize settings with defaults if not set
    await this.initializeSettings();

    // Register flow cards
    this.registerFlowCards();

    // Start tariff monitoring
    this.startTariffMonitor();

    // Store the current tariff to detect changes
    this.currentTariff = this.getCurrentTariff();
    this.log(`Current tariff: ${this.currentTariff}`);

    // History buffer for widget charts (last 24h at 1-minute intervals)
    this.history = [];

    // Initialize HomeyAPI for accessing other devices (non-blocking)
    this.initHomeyAPI().catch(err => {
      this.error('HomeyAPI init failed in onInit:', err.message);
    });
  }

  async initializeSettings() {
    const settings = this.homey.settings;

    // Default rates (EUR/kWh) - Energo-Pro Bulgaria typical rates
    if (settings.get('dayRate') === null) {
      settings.set('dayRate', 0.12);
    }
    if (settings.get('nightRate') === null) {
      settings.set('nightRate', 0.06);
    }

    // Default seasons configuration
    if (settings.get('seasons') === null) {
      settings.set('seasons', [
        {
          name: 'Winter',
          startMonth: 11, // November
          startDay: 1,
          endMonth: 3, // March
          endDay: 31,
          dayStart: '06:00',
          dayEnd: '22:00'
        },
        {
          name: 'Summer',
          startMonth: 4, // April
          startDay: 1,
          endMonth: 10, // October
          endDay: 31,
          dayStart: '07:00',
          dayEnd: '23:00'
        }
      ]);
    }

    // Currency (Bulgaria switched from BGN to EUR)
    if (settings.get('currency') === null) {
      settings.set('currency', 'EUR');
    }

    this.log('Settings initialized');
  }

  registerFlowCards() {
    // Trigger: When tariff changes
    this.tariffChangedTrigger = this.homey.flow.getTriggerCard('tariff-changed');

    // Trigger: Hourly cost exceeds threshold
    this.costThresholdTrigger = this.homey.flow.getTriggerCard('cost-threshold-exceeded');
    this.costThresholdTrigger.registerRunListener(async (args, state) => {
      return state.cost_per_hour >= args.threshold;
    });

    // Trigger: Daily cost exceeds threshold
    this.dailyCostTrigger = this.homey.flow.getTriggerCard('daily-cost-exceeded');
    this.dailyCostTrigger.registerRunListener(async (args, state) => {
      return state.cost_today >= args.threshold;
    });

    // Trigger: High power device
    this.highPowerDeviceTrigger = this.homey.flow.getTriggerCard('high-power-device');
    this.highPowerDeviceTrigger.registerRunListener(async (args, state) => {
      return state.power >= args.threshold;
    });

    // Condition: Current tariff is...
    const currentTariffCondition = this.homey.flow.getConditionCard('current-tariff-is');
    currentTariffCondition.registerRunListener(async (args) => {
      const currentTariff = this.getCurrentTariff();
      return currentTariff === args.tariff;
    });

    // Action: Get current rate (returns token)
    const getCurrentRateAction = this.homey.flow.getActionCard('get-current-rate');
    getCurrentRateAction.registerRunListener(async (args) => {
      const rate = this.getCurrentRate();
      const tariff = this.getCurrentTariff();
      const currency = this.homey.settings.get('currency') || 'EUR';

      return {
        rate: rate,
        tariff: tariff,
        currency: currency,
        formatted: `${rate.toFixed(4)} ${currency}/kWh`
      };
    });

    // Action: Get top energy consumers
    const getTopConsumersAction = this.homey.flow.getActionCard('get-top-consumers');
    getTopConsumersAction.registerRunListener(async (args) => {
      const topConsumers = await this.getTopConsumers();
      const rate = this.getCurrentRate();

      const formatConsumer = (consumer) => {
        if (!consumer) return 'None';
        return `${consumer.name} (${Math.round(consumer.power)}W)`;
      };

      return {
        top_consumer_1: formatConsumer(topConsumers[0]),
        top_consumer_2: formatConsumer(topConsumers[1]),
        top_consumer_3: formatConsumer(topConsumers[2]),
        total_power: topConsumers.reduce((sum, c) => sum + (c?.power || 0), 0),
        cost_per_hour: (topConsumers.reduce((sum, c) => sum + (c?.power || 0), 0) / 1000) * rate
      };
    });

    this.log('Flow cards registered');
  }

  async initHomeyAPI() {
    try {
      this.log('Initializing HomeyAPIApp...');
      this.api = new HomeyAPIApp({ homey: this.homey });
      this.powerDevices = {};

      this.log('Fetching devices...');
      const devices = await this.api.devices.getDevices();
      const deviceIds = Object.keys(devices);
      this.log(`HomeyAPI connected. Total devices found: ${deviceIds.length}`);

      if (deviceIds.length === 0) {
        this.log('WARNING: No devices returned. Will retry in 30 seconds...');
        this.homey.setTimeout(() => {
          this.initHomeyAPI().catch(err => this.error('Retry failed:', err.message));
        }, 30000);
        return;
      }

      // Log all devices and subscribe to power changes
      for (const [deviceId, device] of Object.entries(devices)) {
        const caps = device.capabilities || [];
        const hasMeasurePower = caps.includes('measure_power');
        const hasMeterPower = caps.includes('meter_power');

        if (hasMeasurePower || hasMeterPower) {
          this.log(`[POWER] ${device.name} (${deviceId}) - capabilities: ${caps.join(', ')}`);
        } else {
          this.log(`[SKIP]  ${device.name} (${deviceId}) - capabilities: ${caps.join(', ')}`);
        }

        if (hasMeasurePower) {
          const power = device.capabilitiesObj?.measure_power?.value || 0;
          this.powerDevices[deviceId] = {
            name: device.name,
            power: power
          };

          // Subscribe to real-time power changes via WebSocket
          device.makeCapabilityInstance('measure_power', (value) => {
            this.powerDevices[deviceId] = {
              name: device.name,
              power: value || 0
            };
          });
        }
      }

      this.apiReady = true;
      this.log(`Tracking ${Object.keys(this.powerDevices).length} power devices out of ${deviceIds.length} total`);

      if (Object.keys(this.powerDevices).length === 0) {
        this.log('WARNING: No devices with measure_power capability found.');
      }

    } catch (error) {
      this.error('Failed to initialize HomeyAPI:', error.message);
      this.log('Will retry in 30 seconds...');
      this.homey.setTimeout(() => {
        this.initHomeyAPI().catch(err => this.error('Retry failed:', err.message));
      }, 30000);
    }
  }

  getPowerDevices() {
    if (!this.powerDevices) return [];
    return Object.entries(this.powerDevices).map(([id, data]) => ({
      id,
      name: data.name,
      power: data.power
    }));
  }

  async getTopConsumers() {
    // Return power devices sorted by consumption
    const devices = this.getPowerDevices();
    return devices.sort((a, b) => b.power - a.power).slice(0, 5);
  }

  startTariffMonitor() {
    // Check every minute for tariff changes
    this.tariffCheckInterval = this.homey.setInterval(() => {
      const newTariff = this.getCurrentTariff();

      if (this.currentTariff !== newTariff) {
        this.log(`Tariff changed from ${this.currentTariff} to ${newTariff}`);

        // Trigger the flow card
        this.tariffChangedTrigger.trigger({
          previous_tariff: this.currentTariff,
          new_tariff: newTariff,
          rate: this.getCurrentRate()
        }).catch(err => this.error('Failed to trigger tariff change:', err));

        this.currentTariff = newTariff;
      }
    }, 60000); // Check every minute

    this.log('Tariff monitor started');
  }

  getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1; // JavaScript months are 0-indexed
    const day = now.getDate();
    const seasons = this.homey.settings.get('seasons') || [];

    for (const season of seasons) {
      if (this.isDateInSeason(month, day, season)) {
        return season;
      }
    }

    // Fallback to first season if none match
    return seasons[0] || null;
  }

  isDateInSeason(month, day, season) {
    const { startMonth, startDay, endMonth, endDay } = season;

    // Handle seasons that cross year boundary (e.g., Winter: Nov-Mar)
    if (startMonth > endMonth) {
      // Season crosses year boundary
      return (month > startMonth || (month === startMonth && day >= startDay)) ||
             (month < endMonth || (month === endMonth && day <= endDay));
    } else {
      // Season within same year
      return (month > startMonth || (month === startMonth && day >= startDay)) &&
             (month < endMonth || (month === endMonth && day <= endDay));
    }
  }

  getCurrentTariff() {
    const season = this.getCurrentSeason();
    if (!season) return 'day'; // Default to day if no season configured

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const dayStart = season.dayStart || '06:00';
    const dayEnd = season.dayEnd || '22:00';

    // Check if current time is within day tariff hours
    if (currentTime >= dayStart && currentTime < dayEnd) {
      return 'day';
    }
    return 'night';
  }

  getCurrentRate() {
    const tariff = this.getCurrentTariff();
    const settings = this.homey.settings;

    if (tariff === 'day') {
      return settings.get('dayRate') || 0.12;
    }
    return settings.get('nightRate') || 0.06;
  }

  getFormattedRate() {
    const rate = this.getCurrentRate();
    const currency = this.homey.settings.get('currency') || 'EUR';
    return `${rate.toFixed(4)} ${currency}/kWh`;
  }

  recordHistory(totalPower, costPerHour, costToday) {
    this.history.push({
      t: Date.now(),
      power: totalPower,
      costH: costPerHour,
      costDay: costToday
    });
    // Keep last 24 hours (1440 entries at 1-min intervals)
    const maxEntries = 1440;
    if (this.history.length > maxEntries) {
      this.history = this.history.slice(-maxEntries);
    }
  }

  getChartData() {
    const tariff = this.getCurrentTariff();
    const rate = this.getCurrentRate();
    const currency = this.homey.settings.get('currency') || 'EUR';
    const totalPower = this.getPowerDevices().reduce((sum, d) => sum + d.power, 0);

    return {
      current: {
        tariff,
        rate,
        currency,
        totalPower,
        costPerHour: (totalPower / 1000) * rate,
      },
      history: this.history,
    };
  }

  async onUninit() {
    if (this.tariffCheckInterval) {
      this.homey.clearInterval(this.tariffCheckInterval);
    }
    this.log('Electricity Tariff app has been uninitialized');
  }

}

module.exports = ElectricityTariffApp;