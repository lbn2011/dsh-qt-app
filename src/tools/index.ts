// Barrel for the I2 tool projection surface.
//
// The projection is a pure, synchronous module: it takes the official session
// events (`tool/call`, `tool/result`) and produces one flat `ToolRowDTO` per
// tool call. It owns no timers, no transport and no globals, so the host can
// feed it from the session event stream and the QML side can rebuild its view
// from a single snapshot call.

export * from './dto.js'
export * from './projection.js'
