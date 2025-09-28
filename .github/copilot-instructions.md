# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context

**Adapter Name:** ioBroker.philips-air
**Primary Function:** Connects Philips air purifier devices with ioBroker for smart home automation
**Key Features:**
- Communication with Philips air purifiers via COAP protocol with encryption
- Support for AC2729 model and similar new purifiers
- Real-time monitoring of air quality data, filter status, and device settings
- Control capabilities for fan speed, mode, and other purifier settings
- Auto-discovery of devices via IP address (typically shown as `MiCO` in router)

**Key Dependencies:**
- `@iobroker/adapter-core` - Core ioBroker adapter functionality
- `coap` - COAP protocol communication library for connecting to Philips devices
- `philips-air` (optional) - Additional Philips air purifier integration library

**Configuration Requirements:**
- Device IP address (required) - Found in router, often shows as "MiCO"
- Device-specific variables may vary between different purifier models
- Some variables might remain unfilled in object tree for unsupported device features

**Device Communication:**
- Uses COAP (Constrained Application Protocol) for device communication
- Supports encrypted communication with newer Philips purifier models
- Handles device discovery and status polling
- Manages connection retry logic for network reliability

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_DEVICE_IP = '192.168.1.100'; // Example Philips device IP
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.philips-air.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties for Philips Air
                        Object.assign(obj.native, {
                            ip: TEST_DEVICE_IP, // Required: Device IP address
                            // Add other Philips-specific configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check connection status
                        const connectionState = await new Promise((res, rej) => {
                            harness.states.getState('philips-air.0.info.connection', (err, state) => {
                                if (err) return rej(err);
                                res(state);
                            });
                        });

                        if (connectionState && connectionState.val === true) {
                            console.log('✅ SUCCESS: Device connected successfully');
                        }

                        resolve();
                        
                    } catch (error) {
                        console.error('❌ Integration test failed:', error.message);
                        reject(error);
                    }
                });
            }).timeout(60000);
        });
    }
});
```

#### Testing Best Practices for Philips Air Adapter
- Mock COAP communication when device is not available
- Test connection retry logic
- Validate proper state creation for air quality metrics
- Test error handling for network timeouts
- Ensure proper cleanup of COAP connections
- Test device discovery and IP validation

## Core Adapter Patterns

### Adapter Lifecycle Management

#### Startup and Initialization
```javascript
class PhilipsAir extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'philips-air' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    // Initialize device connection
    if (!this.config.ip) {
      this.log.error('Device IP address not configured');
      return;
    }
    
    await this.connectToDevice();
    this.startPolling();
  }
}
```

#### Proper Resource Cleanup
```javascript
onUnload(callback) {
  try {
    // Clear all timers
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    
    // Close COAP connections
    if (this.coapClient) {
      this.coapClient.close();
      this.coapClient = undefined;
    }
    
    callback();
  } catch (e) {
    callback();
  }
}
```

### State Management

#### Creating Device States
```javascript
await this.setObjectNotExistsAsync('info.connection', {
  type: 'state',
  common: {
    name: 'Device connection status',
    type: 'boolean',
    role: 'indicator.connected',
    read: true,
    write: false,
  },
  native: {},
});

await this.setObjectNotExistsAsync('status.pm25', {
  type: 'state',
  common: {
    name: 'PM2.5 level',
    type: 'number',
    role: 'level.air.pm25',
    unit: 'µg/m³',
    read: true,
    write: false,
  },
  native: {},
});
```

#### State Updates with Proper Error Handling
```javascript
async updateDeviceState(key, value) {
  try {
    await this.setStateAsync(key, { val: value, ack: true });
  } catch (error) {
    this.log.error(`Failed to update state ${key}: ${error.message}`);
  }
}
```

### COAP Communication Patterns

#### Device Connection
```javascript
const coap = require('coap');

async connectToDevice() {
  try {
    this.coapClient = coap.createClient({
      host: this.config.ip,
      port: 5683,
      timeout: 30000
    });
    
    // Test connection
    const response = await this.sendCoapRequest('GET', '/status');
    if (response) {
      this.log.info('Successfully connected to Philips device');
      await this.setStateAsync('info.connection', true, true);
      return true;
    }
  } catch (error) {
    this.log.error(`Connection failed: ${error.message}`);
    await this.setStateAsync('info.connection', false, true);
    return false;
  }
}
```

#### Handling State Changes (Control Commands)
```javascript
async onStateChange(id, state) {
  if (!state || state.ack) return;
  
  try {
    const deviceId = id.split('.')[2];
    const command = id.split('.').pop();
    
    switch (command) {
      case 'power':
        await this.sendDeviceCommand('power', state.val);
        break;
      case 'fanSpeed':
        await this.sendDeviceCommand('fan_speed', state.val);
        break;
      default:
        this.log.warn(`Unknown command: ${command}`);
    }
  } catch (error) {
    this.log.error(`Command execution failed: ${error.message}`);
  }
}
```

## Error Handling and Logging

### Proper Logging Levels
```javascript
// Use appropriate logging levels
this.log.error('Critical errors that prevent adapter from working');
this.log.warn('Warnings about unexpected conditions');
this.log.info('General information about adapter operations');
this.log.debug('Detailed debugging information (only in debug mode)');
```

### Network Error Handling
```javascript
async handleNetworkError(error) {
  if (error.code === 'ECONNREFUSED') {
    this.log.warn('Device refused connection, will retry...');
    await this.scheduleReconnect(30000);
  } else if (error.code === 'ETIMEDOUT') {
    this.log.warn('Connection timeout, device may be offline');
    await this.setStateAsync('info.connection', false, true);
  } else {
    this.log.error(`Network error: ${error.message}`);
  }
}
```

### Connection Recovery
```javascript
async scheduleReconnect(delay = 60000) {
  if (this.connectionTimer) {
    clearTimeout(this.connectionTimer);
  }
  
  this.connectionTimer = setTimeout(async () => {
    this.log.info('Attempting to reconnect...');
    await this.connectToDevice();
  }, delay);
}
```

## JSON Config Management

### Admin Configuration UI
```json
{
  "type": "panel",
  "items": {
    "ip": {
      "type": "ip",
      "label": "Device IP Address",
      "help": "IP address of your Philips air purifier (often shows as 'MiCO' in router)"
    },
    "pollInterval": {
      "type": "number",
      "label": "Polling Interval",
      "help": "How often to poll device status (seconds)",
      "min": 10,
      "max": 3600,
      "default": 30
    },
    "timeout": {
      "type": "number",
      "label": "Connection Timeout",
      "help": "COAP connection timeout in milliseconds",
      "min": 5000,
      "max": 60000,
      "default": 30000
    }
  }
}
```

### Configuration Validation
```javascript
validateConfig() {
  if (!this.config.ip || !this.config.ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    throw new Error('Valid IP address is required');
  }
  
  if (this.config.pollInterval < 10 || this.config.pollInterval > 3600) {
    this.log.warn('Poll interval adjusted to valid range (10-3600 seconds)');
    this.config.pollInterval = Math.max(10, Math.min(3600, this.config.pollInterval));
  }
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods
- Handle COAP communication errors gracefully
- Implement connection retry logic with exponential backoff
- Validate device IP addresses before attempting connections
- Use appropriate ioBroker state roles for air quality measurements

## CI/CD and Testing Integration

### GitHub Actions for Device Testing
For adapters with physical device dependencies, implement separate CI/CD jobs:

```yaml
# Tests device connectivity with mock data (runs separately)
device-mock-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run mock device tests
      run: npm run test:integration-mock
```

### CI/CD Best Practices
- Run device tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make device connectivity tests required for deployment
- Provide clear failure messages for connection issues
- Use appropriate timeouts for COAP communication (30+ seconds)
- Mock COAP responses for reliable CI testing

### Package.json Script Integration
Add dedicated script for device testing:
```json
{
  "scripts": {
    "test:integration-mock": "mocha test/integration-mock --exit"
  }
}
```

### Practical Example: Complete Device Testing Implementation

#### test/integration-mock.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Mock COAP responses for testing
const mockDeviceResponses = {
  '/status': {
    pm25: 15,
    filter_life: 85,
    power: 'on',
    fan_speed: 2
  }
};

// Run integration tests with mock device
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Device Testing with Mock Data", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to device and initialize with mock data", async () => {
                console.log("Setting up mock device configuration...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                await harness.changeAdapterConfig("philips-air", {
                    native: {
                        ip: "127.0.0.1", // Use localhost for mock testing
                        pollInterval: 10,
                        timeout: 5000
                    }
                });

                console.log("Starting adapter with mock device...");
                await harness.startAdapter();
                
                // Wait for initialization
                await new Promise(resolve => setTimeout(resolve, 30000));
                
                const connectionState = await harness.states.getStateAsync("philips-air.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: Mock device connection established");
                    return true;
                } else {
                    throw new Error("Mock Device Test Failed: Expected device connection to be established. " +
                        "Check logs above for specific COAP errors (connection refused, timeout, etc.)");
                }
            }).timeout(60000);
        });
    }
});
```

This comprehensive setup provides GitHub Copilot with the context needed to assist effectively with Philips Air Purifier adapter development, including device-specific communication patterns, testing strategies, and best practices for IoT device integration.