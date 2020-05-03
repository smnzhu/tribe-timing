import http from "http";
import socketClusterServer from "socketcluster-server";

const options = {
  authKey: null
};

const httpServer = http.createServer();
const agServer = socketClusterServer.attach(httpServer, options);

httpServer.listen(8000);

const providerStates = new Proxy(
  {},
  {
    get: (target, name) =>
      name in target
        ? target[name]
        : (target[name] = {
            eventId: 0,
            vector: {
              position: 0,
              velocity: 0,
              acceleration: 0,
              timestamp: performance.now() / 1e3
            },
            range: [-Infinity, Infinity]
          })
  }
);

const withinRange = (vector, range) => {
  const {position, velocity, acceleration} = vector;
  const [startPosition, endPosition] = range;
  return position > endPosition ||
    position < startPosition ||
    (position === endPosition &&
      (velocity > 0 || (velocity === 0 && acceleration > 0))) ||
    (position === startPosition &&
      (velocity < 0 || (velocity === 0 && acceleration < 0)))
    ? false
    : true;
};

const handleUpdate = (providerState, vector) => {
  if (!withinRange(vector, providerState.range)) {
    throw new Error(`Invalid update vector: ${vector}`);
  }
  // TODO: check that the given timestamp is close enough to current timestamp?
  // if (Math.abs(vector.timestamp - performance.now / 1e3) < eps) {}
  vector.timestamp = performance.now() / 1e3;
  providerState.vector = vector;
};

const handleSetRange = (providerState, range) => {
  if (!withinRange(providerState.vector, range)) {
    throw new Error(`Invalid range: ${range}`);
  }
  providerState.range = range;
};

const handlePublish = (channel, data) => {
  const providerState = providerStates[channel];
  const {type, payload} = data;
  switch (type) {
    case "update":
      handleUpdate(providerState, payload);
      break;
    case "setRange":
      handleSetRange(providerState, payload);
      break;
    default:
      throw new Error(`Unrecognized message type: ${type}`);
  }
  data.eventId = providerState.eventId++;
};

// once a room is closed, client won't be able to do anything, even with
// a valid jwt token, since the room won't exist.
// So, maybe a keep a mapping of rooms to userId's in Redis. Then, in the
// JWT all we need to do is keep the user's userID. when they connect to
// this service and try to subscribe, we just need to check if the userID
// is in the given channel / room.
// should we also check if channel is in jwt?

// Maybe we can use redis to communicate from main socket service when a new
// room is created / destroyed? That way we can just create a provider when the
// room is created, and delete it when the room is closed. We can also implement
// checking to see if a room exists.

// Three different concepts:
// Room: This is created from the API! Represents the abstract concept of a room
// ChatService: This corresponds to a room, and the chat inside it.
// TimingProvider: Also corresponds to a room.
// But then the question arises: When should a room be deleted? if it's not
// created on join and deleted on leave...

// Room endpoint can create a room, and it returns tokens for the chat, timing,
// and twilio video services. Automatically adds the user to the room
// Join endpoint
// Once all users leave,

// cases to consider:
// 1) Room is destroyed before authToken expires.
// 2) Room is destoyed, then new room with same ID is created before authToken
//    expires for users from the old room.
// 3) On room destruction, all sockets connected to the corresponding provider
//    should be unsubscribed from the channel.
// 4) If user leaves the room, they should be unsubbed from the provider channel
// 5) When user disconnects from the socket

agServer.setMiddleware(agServer.MIDDLEWARE_INBOUND, async middlewareStream => {
  for await (let action of middlewareStream) {
    if (action.type === action.SUBSCRIBE) {
      const {socket, channel} = action;
      const authToken = socket.authToken;
      if (!authToken || authToken.providerId !== channel) {
        const subscribeError = new Error(
          `You are not authorized to subscribe to the ${channel} channel`
        );
        subscribeError.name = "SubscribeError";
        action.block(subscribeError);
        continue;
      }
      socket.transmit("initialize", providerStates[channel]);
    } else if (action.type === action.PUBLISH_IN) {
      const {socket, channel, data} = action;
      let publishError;
      if (!socket.isSubscribed(channel)) {
        publishError = new Error(
          `You must be subscribed to publish to the ${channel} channel`
        );
      } else {
        try {
          handlePublish(channel, data);
        } catch (err) {
          publishError = err;
        }
      }
      if (publishError) {
        publishError.name = "PublishError";
        action.block(publishError);
        continue;
      }
    }
    action.allow();
  }
});

(async () => {
  for await (let {socket} of agServer.listener("connection")) {
    (async () => {
      for await (let request of socket.procedure("ping")) {
        // send pong
        request.end(performance.now());
      }
    })();
  }
})();
