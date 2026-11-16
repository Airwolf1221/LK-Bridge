# Bug report for LegendKeeper: `labelSize` cannot be round-tripped through the v3 API

_Draft for the owner to send (15 November 2026). Nothing in it identifies a project; add the project and request ids
yourself if LegendKeeper asks for them._

## Summary

The v3 API's feature endpoints disagree about the values of `labelSize`. The write endpoints accept only the new sizes
(`xs` to `3xl`). The list endpoint returns only the old ones (`small`, `medium`, `large`), and refuses the whole request
when any feature holds a new one. Writing a label size through the API therefore makes every feature of that map
unreadable through the API.

## The two schemas

- **Writes:** `FeatureCreateParams` and `FeatureUpdateParams` (`POST` and `PATCH
/api/v3/projects/{projectId}/resources/{resourceId}/docs/{documentId}/features[/{featureId}]`) define `labelSize` as
  `enum: [xs, sm, md, lg, xl, 2xl, 3xl]`. So `small`, `medium` and `large`, which the app writes for features drawn
  there, are not valid in a write. (Our client checks requests against the published schema, so it refused these values
  before sending them. We have not confirmed what the server itself answers.)
- **Reads:** `listFeatures` (`GET …/docs/{documentId}/features`) validates its response against `small | medium | large`.
  The `Feature` schema's own description of `labelSize` says it is "written as `xs` to `3xl`; features drawn in the app
  may hold `small`, `medium` or `large`".

## The error

After one feature of a map has been created with `labelSize: "md"`, every `listFeatures` request for that map answers:

```
400 VALIDATION_ERROR  "Validation error"
errors: [{"path":"labelSize","message":"Invalid enum value. Expected 'small' | 'medium' | 'large', received 'md'"}]
```

## How to reproduce

1. On any map document, create a label with the API:
   `POST …/docs/{documentId}/features` with
   `{"type":"label","name":"Test","pos":[0,0],"labelSize":"md"}`. It answers 201.
2. `GET …/docs/{documentId}/features`. It answers the 400 above, instead of the list.
3. Delete that feature by its id (`DELETE …/features/{featureId}`), or set its label size again in the app (small, medium
   or large). `listFeatures` answers 200 again.

The reverse cannot work either: the write schemas do not list `small`, the only kind of value `listFeatures` returns.

## Its effect

- No client can set a label size and still read the map. One such feature hides every other feature of the map from
  `listFeatures`.
- A backup that copies a map's features cannot restore their label sizes. The values it reads (`small`, `medium`,
  `large`) cannot be written, and the values it could write break the next read.
- Our integration has stopped sending `labelSize` at all until this is fixed. Label sizes have to be set in the app.

## What we would expect

`listFeatures` (and `getFeature`) should return whatever the write endpoints accept. Either accept both sets in every
endpoint and convert, or return new sizes for features drawn in the app. Any one consistent enum works.
