'use strict';

const Homey = require('homey');

class TariffMeterDevice extends Homey.Device {

  async onInit() {
    this.log('Tariff Meter device has been initialized');

    // Initialize tracking variables
    this.lastTariff = null;
    this.tariffChangesToday = 0;
    this.lastResetDate = new Date().toDateString();

    // Cost accumulation tracking
    this.costToday = 0;
    this.lastCostUpdate = Date.now();
    this.devicePowers = [];

    // Update tariff values immediately
    await this.updateTariffValues();

    // Set up interval to update tariff values and cost every minute
    this.updateInterval = this.homey.setInterval(async () => {
      await this.updateTariffValues();
      await this.updateCostTracking();
    }, 60000);

    // Do initial cost tracking after a delay (let app API initialize first)
    this.homey.setTimeout(async () => {
      const app = this.homey.app;
      if (app && app.apiReady) {
        await this.updateCostTracking();
      } else {
        this.log('API not ready for initial cost tracking, will start on next interval');
      }
    }, 10000);

    // Listen for settings changes
    this.homey.settings.on('set', async (key) => {
      if (['dayRate', 'nightRate', 'seasons', 'currency'].includes(key)) {
        this.log('Settings changed, updating tariff values');
        await this.updateTariffValues();
      }
    });
  }

  getDevicesWithPower() {
    const app = this.homey.app;
    if (app && app.apiReady && app.getPowerDevices) {
      return app.getPowerDevices();
    }
    if (app && !app.apiReady) {
      this.log('API not ready yet, no power devices available');
    }
    return [];
  }

  async updateCostTracking() {
    try {
      const now = Date.now();
      const timeDelta = (now - this.lastCostUpdate) / 1000 / 3600; // Hours since last update
      const currentRate = this.getCurrentRate(this.getCurrentTariff(this.getCurrentSeason()));

      // Get total power from all subscribed devices
      const powerDevices = this.getDevicesWithPower();
      let totalPower = 0;

      for (const device of powerDevices) {
        if (device.power > 0) {
          totalPower += device.power;
        }
      }

      // Store device powers for alerts and top consumers
      this.devicePowers = powerDevices.filter(d => d.power > 0).sort((a, b) => b.power - a.power);

      // Calculate cost since last update (power in W, rate in EUR/kWh)
      const costIncrement = (totalPower / 1000) * timeDelta * currentRate;

      // Reset daily cost at midnight
      const todayString = new Date().toDateString();
      if (this.lastResetDate !== todayString) {
        this.costToday = 0;
        this.lastResetDate = todayString;
        this.log('Daily cost reset');
      }

      this.costToday += costIncrement;
      this.lastCostUpdate = now;

      // Calculate hourly cost (current power * rate)
      const costPerHour = (totalPower / 1000) * currentRate;

      // Calculate monthly estimate based on current daily cost projection
      const nowDate = new Date();
      const hoursToday = nowDate.getHours() + nowDate.getMinutes() / 60;
      const dailyProjection = hoursToday > 0 ? (this.costToday / hoursToday) * 24 : 0;
      const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate();
      const monthEstimate = dailyProjection * daysInMonth;

      // Update capabilities
      await this.setCapabilityValue('measure_power', Math.round(totalPower)).catch(this.error);
      await this.setCapabilityValue('measure_power_total', Math.round(totalPower)).catch(this.error);
      await this.setCapabilityValue('cost_per_hour', costPerHour).catch(this.error);
      await this.setCapabilityValue('cost_today', this.costToday).catch(this.error);
      await this.setCapabilityValue('cost_month_estimate', monthEstimate).catch(this.error);

      // Record data point for widget chart
      const app = this.homey.app;
      if (app && app.recordHistory) {
        app.recordHistory(totalPower, costPerHour, this.costToday);
      }

      if (totalPower > 0 || this.devicePowers.length > 0) {
        this.log(`Power: ${totalPower}W from ${this.devicePowers.length} devices, Cost/h: ${costPerHour.toFixed(4)}EUR, Today: ${this.costToday.toFixed(2)}EUR`);
      }

      // Check and trigger alerts
      await this.checkAlerts(costPerHour, this.costToday, currentRate);

    } catch (error) {
      this.error('Failed to update cost tracking:', error);
    }
  }

  async checkAlerts(costPerHour, costToday, currentRate) {
    const app = this.homey.app;
    if (!app) return;

    // Trigger hourly cost threshold alert
    if (costPerHour > 0 && app.costThresholdTrigger) {
      const totalPower = this.devicePowers.reduce((sum, d) => sum + d.power, 0);
      app.costThresholdTrigger.trigger({
        cost_per_hour: costPerHour,
        total_power: totalPower,
        threshold: costPerHour
      }).catch(err => this.error('Failed to trigger cost threshold:', err));
    }

    // Trigger daily cost threshold alert
    if (costToday > 0 && app.dailyCostTrigger) {
      app.dailyCostTrigger.trigger({
        cost_today: costToday,
        threshold: costToday
      }).catch(err => this.error('Failed to trigger daily cost:', err));
    }

    // Check for high power devices
    if (app.highPowerDeviceTrigger) {
      for (const device of this.devicePowers) {
        const deviceCostPerHour = (device.power / 1000) * currentRate;
        app.highPowerDeviceTrigger.trigger({
          device_name: device.name,
          power: device.power,
          cost_per_hour: deviceCostPerHour
        }).catch(err => this.error('Failed to trigger high power device:', err));
      }
    }
  }

  async updateTariffValues() {
    try {
      const now = new Date();
      const season = this.getCurrentSeason();
      const tariff = this.getCurrentTariff(season);
      const rate = this.getCurrentRate(tariff);
      const minutesUntilChange = this.getMinutesUntilChange(season, tariff);

      // Calculate peak hours remaining today
      const peakHours = this.getPeakHoursRemaining(season);
      const offpeakHours = this.getOffpeakHoursRemaining(season);

      // Calculate daily average rate (weighted by hours)
      const dailyAvgRate = this.getDailyAverageRate(season);

      // Track tariff changes
      this.trackTariffChanges(tariff, now);

      // Update tariff capabilities
      await this.setCapabilityValue('tariff_type', tariff).catch(this.error);
      await this.setCapabilityValue('measure_price', rate).catch(this.error);
      await this.setCapabilityValue('season_name', season?.name || 'Unknown').catch(this.error);
      await this.setCapabilityValue('minutes_until_change', minutesUntilChange).catch(this.error);
      await this.setCapabilityValue('peak_hours_today', peakHours).catch(this.error);
      await this.setCapabilityValue('offpeak_hours_today', offpeakHours).catch(this.error);
      await this.setCapabilityValue('daily_avg_rate', dailyAvgRate).catch(this.error);
      await this.setCapabilityValue('tariff_changes_today', this.tariffChangesToday).catch(this.error);

      this.log(`Updated: ${season?.name}, ${tariff}, ${rate} EUR/kWh, peak: ${peakHours.toFixed(1)}h, offpeak: ${offpeakHours.toFixed(1)}h`);
    } catch (error) {
      this.error('Failed to update tariff values:', error);
    }
  }

  trackTariffChanges(currentTariff, now) {
    // Reset counter at midnight
    const todayString = now.toDateString();
    if (this.lastResetDate !== todayString) {
      this.tariffChangesToday = 0;
      this.lastResetDate = todayString;
    }

    // Track tariff changes and trigger flow
    if (this.lastTariff !== null && this.lastTariff !== currentTariff) {
      this.tariffChangesToday++;
      this.log(`Tariff changed from ${this.lastTariff} to ${currentTariff}`);

      // Trigger flow card
      const app = this.homey.app;
      if (app && app.tariffChangedTrigger) {
        app.tariffChangedTrigger.trigger({
          previous_tariff: this.lastTariff,
          new_tariff: currentTariff,
          rate: this.getCurrentRate(currentTariff)
        }).catch(err => this.error('Failed to trigger tariff change:', err));
      }
    }
    this.lastTariff = currentTariff;
  }

  getPeakHoursRemaining(season) {
    if (!season) return 0;

    const now = new Date();
    const currentTotalMinutes = now.getHours() * 60 + now.getMinutes();

    const [dayStartHour, dayStartMinute] = (season.dayStart || '06:00').split(':').map(Number);
    const [dayEndHour, dayEndMinute] = (season.dayEnd || '22:00').split(':').map(Number);

    const dayStartTotalMinutes = dayStartHour * 60 + dayStartMinute;
    const dayEndTotalMinutes = dayEndHour * 60 + dayEndMinute;

    if (currentTotalMinutes < dayStartTotalMinutes) {
      return (dayEndTotalMinutes - dayStartTotalMinutes) / 60;
    } else if (currentTotalMinutes < dayEndTotalMinutes) {
      return (dayEndTotalMinutes - currentTotalMinutes) / 60;
    } else {
      return 0;
    }
  }

  getOffpeakHoursRemaining(season) {
    if (!season) return 0;

    const now = new Date();
    const currentTotalMinutes = now.getHours() * 60 + now.getMinutes();

    const [dayStartHour, dayStartMinute] = (season.dayStart || '06:00').split(':').map(Number);
    const [dayEndHour, dayEndMinute] = (season.dayEnd || '22:00').split(':').map(Number);

    const dayStartTotalMinutes = dayStartHour * 60 + dayStartMinute;
    const dayEndTotalMinutes = dayEndHour * 60 + dayEndMinute;
    const midnightMinutes = 24 * 60;

    const eveningOffpeak = midnightMinutes - dayEndTotalMinutes;

    if (currentTotalMinutes < dayStartTotalMinutes) {
      const remainingMorning = (dayStartTotalMinutes - currentTotalMinutes) / 60;
      return remainingMorning + (eveningOffpeak / 60);
    } else if (currentTotalMinutes < dayEndTotalMinutes) {
      return eveningOffpeak / 60;
    } else {
      return (midnightMinutes - currentTotalMinutes) / 60;
    }
  }

  getDailyAverageRate(season) {
    if (!season) return 0;

    const dayRate = this.homey.settings.get('dayRate') || 0.12;
    const nightRate = this.homey.settings.get('nightRate') || 0.06;

    const [dayStartHour, dayStartMinute] = (season.dayStart || '06:00').split(':').map(Number);
    const [dayEndHour, dayEndMinute] = (season.dayEnd || '22:00').split(':').map(Number);

    const peakMinutes = (dayEndHour * 60 + dayEndMinute) - (dayStartHour * 60 + dayStartMinute);
    const offpeakMinutes = (24 * 60) - peakMinutes;

    return (peakMinutes * dayRate + offpeakMinutes * nightRate) / (24 * 60);
  }

  getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const seasons = this.homey.settings.get('seasons') || [];

    for (const season of seasons) {
      if (this.isDateInSeason(month, day, season)) {
        return season;
      }
    }

    return seasons[0] || null;
  }

  isDateInSeason(month, day, season) {
    const { startMonth, startDay, endMonth, endDay } = season;

    if (startMonth > endMonth) {
      return (month > startMonth || (month === startMonth && day >= startDay)) ||
             (month < endMonth || (month === endMonth && day <= endDay));
    } else {
      return (month > startMonth || (month === startMonth && day >= startDay)) &&
             (month < endMonth || (month === endMonth && day <= endDay));
    }
  }

  getCurrentTariff(season) {
    if (!season) return 'day';

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (currentTime >= (season.dayStart || '06:00') && currentTime < (season.dayEnd || '22:00')) {
      return 'day';
    }
    return 'night';
  }

  getCurrentRate(tariff) {
    if (tariff === 'day') {
      return this.homey.settings.get('dayRate') || 0.12;
    }
    return this.homey.settings.get('nightRate') || 0.06;
  }

  getMinutesUntilChange(season, currentTariff) {
    if (!season) return 0;

    const now = new Date();
    const currentTotalMinutes = now.getHours() * 60 + now.getMinutes();

    const [dayStartHour, dayStartMinute] = (season.dayStart || '06:00').split(':').map(Number);
    const [dayEndHour, dayEndMinute] = (season.dayEnd || '22:00').split(':').map(Number);

    const dayStartTotalMinutes = dayStartHour * 60 + dayStartMinute;
    const dayEndTotalMinutes = dayEndHour * 60 + dayEndMinute;

    if (currentTariff === 'day') {
      return dayEndTotalMinutes - currentTotalMinutes;
    } else {
      if (currentTotalMinutes >= dayEndTotalMinutes) {
        return (24 * 60 - currentTotalMinutes) + dayStartTotalMinutes;
      } else {
        return dayStartTotalMinutes - currentTotalMinutes;
      }
    }
  }

  getTopConsumers(limit = 5) {
    return (this.devicePowers || []).slice(0, limit);
  }

  async onDeleted() {
    if (this.updateInterval) {
      this.homey.clearInterval(this.updateInterval);
    }
    this.log('Tariff Meter device has been deleted');
  }

}

module.exports = TariffMeterDevice;
