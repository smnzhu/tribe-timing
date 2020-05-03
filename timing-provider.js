import {boundMethod} from "autobind-decorator";

export const TimingProviderState = Object.freeze({
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSING: "closing",
  CLOSED: "closed"
});

const computeTimingStateVector = (vector, newTimestamp) => {
  const {position, velocity, acceleration, timestamp} = vector;
  const delta = newTimestamp - timestamp;
  return {
    position: position + velocity * delta + 0.5 * acceleration * delta ** 2,
    velocity: velocity + acceleration * delta,
    acceleration,
    timestamp: newTimestamp
  };
};

const Tick = {
  SWITCH_MEDIUM: 3,
  SWITCH_LARGE: 10,
  SMALL_DELTA: 20,
  MEDIUM_DELTA: 500,
  LARGE_DELTA: 1e4
};

class Pinger {
  constructor(pingDelay) {
    this._pingDelay = pingDelay || Tick.LARGE_DELTA;
    this._count = 0;
    this._tid = null;
    this._onPing = null;
  }

  start() {
    this._count = 0;
    this.resume();
  }

  pause() {
    if (this._tid != null) {
      clearTimeout(this._tid);
      this._tid = null;
    }
  }

  resume() {
    this.pause();
    tick();
  }

  @boundMethod
  tick() {
    this._count += 1;
    if (this._count < Tick.SWITCH_MEDIUM) {
      this._tid = setTimeout(this.tick, Tick.SMALL_DELTA);
    } else if (count < Tick.SWITCH_LARGE) {
      this._tid = setTimeout(this.tick, Tick.MEDIUM_DELTA);
    } else {
      this._tid = setTimeout(this.tick, this._pingDelay);
    }
    if (this._onPing) {
      this._onPing();
    }
  }

  onPing(handler) {
    this._onPing = handler;
  }
}

// NOTE: when we want to unsync from the room, we can simply unsubscribe
// from the channel!
class TimingProvider {
  constructor(providerId, token, options) {
    options = options || {};

    this._providerId = providerId;
    this._providerChannel = null;
    this._token = token;
    localStorage.setItem("socketcluster.authToken", token);
    this._log = new Array(30);
    this._callbacks = {
      vectorchange: new Map(),
      skewchange: new Map(),
      readystatechange: new Map()
    };
    this._readyState = TimingProviderState.CONNECTING;
    this._skew = null;
    this._vector = null;
    this._range = [-Infinity, Infinity];
    this._socket = null;
    this._pinger = new Pinger(options.pingDelay || 1e3);
    this._pinger.onPing(this._sendPing);
    this._eventId = null;
    this._error = null;

    // TODO
    serverOptions = {
      hostname: "localhost",
      port: 8000,
      autoConnect: false,
      autoReconnect: true,
      secure: true
    };

    this._createClient(serverOptions);
  }

  _createClient(serverOptions) {
    this._socket = socketClusterClient.create(serverOptions);
    // TODO: test what happens if user isn't authorized for the channel
    this._providerChannel = this._socket.subscribe(this._providerId, {
      waitForAuth: true
    });

    const connectingConsumer = this._socket
      .listener("connecting")
      .createConsumer();
    const connectConsumer = this._socket.listener("connect").createConsumer();
    const closeConsumer = this._socket.listener("close").createConsumer();
    const initializeConsumer = this._socket
      .receiver("initialize")
      .createConsumer();
    const subscribeConsumer = this._providerChannel
      .listener("subscribe")
      .createConsumer();
    const subscribeFailConsumer = this._providerChannel
      .listener("subscribeFail")
      .createConsumer();
    const unsubscribeConsumer = this._providerChannel
      .listener("unsubscribe")
      .createConsumer();

    (async () => {
      for await (let event of connectingConsumer) {
        console.log(
          `${new Date()}: connect ${serverOptions.hostname}:${
            serverOptions.port
          }`
        );
        this._setReadyState(TimingProviderState.CONNECTING);
      }
    })();
    (async () => {
      for await (let event of connectConsumer) {
        console.log(`${new Date()}: connected`);
        // this._setReadyState(TimingProviderState.OPEN);
        this._pinger.start();
      }
    })();
    (async () => {
      for await (let event of closeConsumer) {
        const {code, reason} = event;
        console.log(`${new Date()}: connection closed: ${reason} (${code})`);
        this._pinger.pause();
        this._setReadyState(TimingProviderState.CLOSED);
      }
    })();
    (async () => {
      for await (let data of initializeConsumer) {
        console.log(`${new Date()}: initial provider state: ${data}`);
        const {eventId, vector, range} = data;
        this._eventId = eventId;
        this._setVector(vector);
        this._setRange(range);
      }
    })();
    (async () => {
      for await (let event of subscribeConsumer) {
        console.log(`${new Date()}: subscribed to ${this._providerId} channel`);
        this._setReadyState(TimingProviderState.OPEN);
      }
    })();
    (async () => {
      for await (let event of subscribeFailConsumer) {
        console.log(
          `${new Date()}: failed to subscribe to ${this._providerId} channel`
        );
        // this._setReadyState(TimingProviderState.CLOSED);
        // TODO: should we destroy here?
      }
    })();
    (async () => {
      for await (let event of unsubscribeConsumer) {
        console.log(
          `${new Date()}: unsubscribed from ${this._providerId} channel`
        );
        // this._setReadyState(TimingProviderState.CLOSED);
      }
    })();
    (async () => {
      for await (let data of this._providerChannel) {
        const {type, payload, eventId} = data;
        if (this._eventId == null || this._eventId < eventId) {
          this._eventId = eventId;
          switch (type) {
            case "update":
              this._setVector(payload);
              break;
            case "setRange":
              this._setRange(payload);
              break;
            default:
              break;
          }
        }
      }
    })();

    this._socket.connect();
  }

  @boundMethod
  async _sendPing() {
    try {
      const ping = performance.now();
      const pong = await socket.invoke("ping", ping);
      const timestamp = performance.now();
      this._addSample(ping, pong, timestamp);
    } catch (err) {
      // TODO: handle pong timeout
      console.log(err);
    }
  }

  _addSample(ping, pong, timestamp) {
    const entry = {
      ping,
      pong,
      timestamp,
      skew: pong - (ping + timestamp) / 2,
      latency: (timestamp - ping) / 2
    };
    console.log(`new sample: ${entry}`);
    this._log.push(entry);
    this._log.shift();
    this._setSkew(
      this._log.reduce((prev, curr) =>
        prev.latency < curr.latency ? prev : curr
      ).skew / 1e3
    );
  }

  destroy() {
    // TODO: instead of checking the state, should instead check something
    // else, since state can be set during "close" listeners above, but we
    // should still do the destroy.
    if (
      [TimingProviderState.CLOSING, TimingProviderState.CLOSED].includes(
        this._readyState
      )
    )
      throw new Error("The timing provider is already destroyed.");
    this._setReadyState(TimingProviderState.CLOSING);
    this._pinger.pause();
    this._providerChannel.close();
    this._socket.closeAllListeners();
    this._socket.closeAllReceivers();
    this._socket.disconnect();
    this._setReadyState(TimingProviderState.CLOSED);
  }

  get readyState() {
    return this._readyState;
  }

  get skew() {
    return this._skew;
  }

  get vector() {
    return {...this._vector};
  }

  get range() {
    return [...this._range];
  }

  get startPosition() {
    return this._range[0];
  }

  get endPosition() {
    return this._range[1];
  }

  get error() {
    return this._error;
  }

  _serverClock() {
    return performance.now() / 1e3 + this._skew;
  }

  update(vector) {
    // TODO: check that vector is in range. If not, use checkUpdate to force
    // it into range.
    if (this._readyState !== TimingProviderState.OPEN) {
      return Promise.reject(
        new Error("The timing provider is not open and can't be updated.")
      );
    }

    const {position, velocity, acceleration} = vector ?? {};
    vector = {
      ...computeTimingStateVector(this._vector, this._serverClock()),
      ...Object.fromEntries(
        Object.entries({position, velocity, acceleration}).filter(
          ([k, v]) => v != null
        )
      )
    };

    return this._providerChannel.invokePublish({
      type: "update",
      payload: vector
    });
  }

  _setVector(vector) {
    this._vector = vector;
    this._dispatchEvent("vectorchange");
  }

  _setRange(range) {
    // TODO: checkRange
    this._range = range;
  }

  _setSkew(skew) {
    if (this._skew != skew) {
      this._skew = skew;
      this._dispatchEvent("skewchange");
    }
  }

  _setReadyState(readyState) {
    if (this._readyState != readyState) {
      this._readyState = readyState;
      this._dispatchEvent("readystatechange");
    }
  }

  _dispatchEvent(type) {
    if (this._callbacks.hasOwnProperty(type)) {
      this._callbacks[type].forEach((ctx, handler) => {
        try {
          handler.call(ctx);
        } catch (err) {
          console.log(`Error in ${type}: ${handler}:`, err);
        }
      });
    }
  }

  on(type, handler, ctx) {
    if (typeof handler !== "function") throw new Error("Illegal handler");
    if (!this._callbacks.hasOwnProperty(type))
      throw new Error(`Unsupported event ${type}`);
    if (!this._callbacks[type].has(handler)) {
      this._callbacks[type].set(handler, ctx ?? this);
    }
    return this;
  }

  off(type, handler) {
    if (this._callbacks.hasOwnProperty(type)) {
      this._callbacks[type].delete(handler);
    }
    return this;
  }
}

export default TimingProvider;
