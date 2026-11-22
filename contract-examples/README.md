# Contract examples

These examples execute the package's pure reducers with deterministic, deployment-neutral inputs. They demonstrate the boundary between sensor or user events, semantic policy output, target-owner commands, and observed completion.

Run every example after compiling the package:

```sh
npm run examples
```

Run one example and inspect its complete JSON contract:

```sh
npm run build
node contract-examples/source-readiness.mjs
```

| Example | Contract demonstrated |
|---|---|
| [`occupancy-fusion.mjs`](occupancy-fusion.mjs) | Motion establishes occupancy; optional presence can hold it. |
| [`motion-lighting.mjs`](motion-lighting.mjs) | Occupancy and illuminance produce semantic lighting intent. |
| [`switch-gestures.mjs`](switch-gestures.mjs) | A double action requests explicit manual full brightness. |
| [`room-lighting.mjs`](room-lighting.mjs) | One room controller converts intent into the transport command. |
| [`source-readiness.mjs`](source-readiness.mjs) | Fresh application evidence, not command success, confirms readiness. |
| [`volume-ownership.mjs`](volume-ownership.mjs) | Relative requests accumulate, bounds apply, and fresh evidence releases ownership. |
| [`theatre-activity.mjs`](theatre-activity.mjs) | A coordinated activity waits for fresh target-owner evidence. |

Each example asserts its central invariant before returning the configuration, inputs, commands or effects, outputs, and invariant as JSON. Identifiers, topics, timestamps, coordinates, and profiles are synthetic.
