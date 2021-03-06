"use strict";

const EventEmitter = require('events').EventEmitter;

const debug = require('debug');
const info = debug('unipi-neuron:board:info');
const warn = debug('unipi-neuron:board:warn');
const log = debug('unipi-neuron:board:log');
const error = debug('unipi-neuron:board:error');

/**
 * Modbus exceptions codes
 */

const MODUS_ERRNO = {
    0x01: "Illegal Function",
    0x02: "Illegal Data Address",
    0x03: "Illegal Data Value",
    0x04: "Failure In Associated Device",
    0x05: "Acknowledge",
    0x06: "Busy, Rejected Message",
    0x07: "NAK – Negative Acknowledgement",
    0x08: "Memory Parity Error",
    0x0A: "Gateway Path Unavailable",
    0x0B: "Gateway Target Device Failed to respond"
};

/**
 * Represents a single board.
 * 
 * @class Board
 * @extends {EventEmitter}
 */
class Board extends EventEmitter {

    /**
     * Create a single board.
     *
     * @param client
     *   A TCP or RTU connection object.
     * @param id
     *   The board id to connect to.
     * @param groups
     *   The number of groups.
     */
    constructor(client, id, groups) {
        super();
        this.client = client;
        this.state = {};
        this.counter = {};
        this.groups = [];

        let self = this;

        // Connect to the board.
        this.client.connect(() => {
            this.client.setID(id);

            // Read board possibilities
            for (let i = 0; i < groups; i++) {
                // We can read the input and output capabilities of group one on register 1001, for group two on 1101
                // and so on.
                let start = 1001 + (i * 100);
                this.client.readHoldingRegisters(start, 2, (err, data) => {
                    if (err) {
                        const errdesc = MODUS_ERRNO[parseInt(err.message.split(' ')[-1])];
                        if (errdesc) error(errdesc);
                        else error(err);
                    } else {
                        let bin = self.dec2bin(data.data[0]);
                        let ext = self.dec2bin(data.data[1]);
                        // On first register adress : first eight bits are for the input number, second eight bits are for the output number.
                        // On second register address : first four bits are for the serial port number, second four bits are for the analog input number, third eight bits are for the analog output number.
                        this.groups[i] = {
                            'id': (i + 1),
                            'di': (parseInt(bin.slice(0, 8), 2)),
                            'do': (parseInt(bin.slice(8, 16), 2)),
                            'ai': (parseInt(ext.slice(4, 8), 2)),
                            'ao': (parseInt(ext.slice(8, 16), 2)),
                            'serial': (parseInt(ext.slice(0, 4), 2)),
                        };
                    }
                });
            }
        });
    }

    /**
     * Validate that the given id is known to this board.
     *
     * @param id
     *   e.g. local-DO1.1
     */
    validate(id) {
        if (this.getState(id) === undefined) {
            throw new SyntaxError('Unknown ID: ' + id);
        }
    }

    /**
     * Get the value of the given io id.
     *
     * @param id
     *   e.g. DO1.1
     */
    getState(id) {
        return this.state[id];
    }

    /**
     * Get the value of the given DI id.
     *
     * @param id
     *   e.g. DI1.1
     */
    getCount(id) {
        return this.counter[id];
    }

    /**
     * Set an io to the given value
     *
     * @param id
     *   e.g. local-DO1.1
     * @param {boolean} value
     * @param {int} retries
     *   Used internally to check how many retries have been tried.
     */
    set(id, value, retries = 0) {
        this.validate(id);

        let arr = id.split('.');
        let group = arr[0].substr(arr[0].length - 1, 1);
        let num = arr[1];
        let coilId = (group - 1) * 100 + (num - 1);

        // Actual write to the board.
        this.client.writeCoil(coilId, value);

        // Writing can sometimes fail, especially on boards connected over a (bad) UART connection. Validating the write
        // and retrying the write after a small delay mitigates the problem.
        if (retries < 5) {
            setTimeout(() => {
                if (Boolean(this.getState(id)) !== value) {
                    retries++;
                    console.log('Retry (' + retries + ')');
                    this.set(id, value, retries);
                }
            }, (100 * (retries + 1)));
        }
    }

    /**
     * Convert the given decimal value to a 16bit binary string.
     *
     * @param dec
     * @returns {string}
     */
    dec2bin(dec) {
        // Convert decimal string to binary.
        let bin = parseInt(dec, 10).toString(2);
        // Pad to a 16bit binary number.
        return ('0000000000000000' + bin.toString()).slice(-16);
    }

    /**
     * Convert and store the given group array data in the data variable.
     *
     * @param prefix
     *   The io prefix (e.g. DO, DI ...)
     * @param value
     *   The value array from readHoldingRegisters
     * @param length
     *   The length of the io group, defaults to 16.
     */
    storeState(prefix, value, length = 16) {
        let bin = this.dec2bin(value);

        // Convert to an array and reverse the values (first bit -> first value)
        let arr = bin.split('').reverse();

        for (let i = 0; i < length; i++) {
            let id = prefix + '.' + (i + 1);
            let value = parseInt(arr[i]);
            let currentValue = this.getState(id);
            if (currentValue !== value) {
                this.state[id] = value;
                if (currentValue !== undefined) {
                    this.emit('update', id, value.toString());
                }
            }
        }
    }

    /**
     * Update the board io states by reading the holding registers.
     */
    updateState() {
        for (let i = 0; i < this.groups.length; i++) {
            let group = this.groups[i];
            let start = (group.id - 1) * 100;
            // Read DI and DO states
            this.client.readHoldingRegisters(start, 2, (err, data) => {
                if (err) {
                    const errdesc = MODUS_ERRNO[parseInt(err.message.split(' ')[-1])];
                    if (errdesc) error(errdesc);
                    else error(err);
                } else {
                    this.storeState('DI' + group.id, data.data[0], group.di);
                    this.storeState('DO' + group.id, data.data[1], group.do);
                }
            });
        }
    }

    /**
     * Update the board io states by reading the holding registers.
     */
    updateCount() {
        // Look for a better way of determining these.
        let countStart = [8, 103, 203];

        for (let i = 0; i < this.groups.length; i++) {
            let group = this.groups[i];
            // Read DI counters
            this.client.readHoldingRegisters(countStart[i], (group.di * 2), (err, data) => {
                if (err) {
                    const errdesc = MODUS_ERRNO[parseInt(err.message.split(' ')[-1])];
                    if (errdesc) error(errdesc);
                    else error(err);
                } else {
                    for (let j = 0; j < group.di; j++) {
                        let id = 'DI' + group.id + '.' + (j + 1);
                        // Counters are stored over two words.
                        this.counter[id] = data.data[j * 2] + data.data[j * 2 + 1];
                    }
                }
            });
        }
    }

}

module.exports = Board;