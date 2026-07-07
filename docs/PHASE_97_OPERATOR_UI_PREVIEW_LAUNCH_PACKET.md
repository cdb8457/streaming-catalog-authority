# Phase 97 - Operator UI Preview Launch Packet

Phase 97 packages safe command shapes for viewing the existing static Operator UI preview. It does
not implement a new UI, HTTP API, live packet source, database reader, provider adapter, media-server
workflow, reverse proxy, auth/session system, scheduler, or Unraid service.

The static preview remains fixture-only. Remote exposure remains blocked. O4 remains open/deferred.
O5 remains open/deferred. `FileCustodian` remains a hardened reference harness, not production KMS.

## CLI

Text output:

```sh
npm run ops:operator-ui-preview-launch-packet
```

JSON output:

```sh
npm run --silent ops:operator-ui-preview-launch-packet -- -- --json
```

The command is static and no-input. It reads no environment variables, files, database rows,
provider data, Unraid state, packet sources, credentials, key material, backup contents, logs, or
media metadata.

## Safe Launch Shapes

Local workstation preview:

```sh
npm run ops:operator-ui-static-runtime -- -- --serve --host 127.0.0.1 --port 4173
```

Unraid preview must remain loopback-only. If the runtime is started on Unraid, view it through an
operator-controlled SSH tunnel rather than publishing it on the LAN:

```sh
ssh -L 4174:127.0.0.1:4173 root@<unraid-host>
```

Then open the forwarded local URL from the operator workstation.

## Blocked Shapes

- Binding the runtime to `0.0.0.0`.
- Publishing the preview through Traefik, nginx, Cloudflare Tunnel, Newt, or another reverse proxy.
- Feeding the preview live catalog DB data.
- Feeding the preview provider/debrid/media-server data.
- Treating the preview as production UI, launch approval, O4 closure, or O5 closure.

## Boundary

This packet only makes the fixture preview easier to launch safely. It does not authorize live data,
remote exposure, provider contact, media-server integration, playback, download, scraping, or runtime
custodian/KMS work.

