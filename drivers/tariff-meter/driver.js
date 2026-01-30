'use strict';

const Homey = require('homey');

class TariffMeterDriver extends Homey.Driver {

  async onInit() {
    this.log('Tariff Meter driver has been initialized');
  }

  async onPairListDevices() {
    // Return a single virtual device for pairing
    return [
      {
        name: 'Electricity Tariff',
        data: {
          id: 'energy-tariff-meter'
        }
      }
    ];
  }

}

module.exports = TariffMeterDriver;
