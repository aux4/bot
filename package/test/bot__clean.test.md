# aux4 bot clean

Sweeps expired records out of every repository table `aux4/bot` manages, via
a single `aux4 repository clean --db <db>` call.

```afterAll
rm -f clean-test.db
```

## sweeping an expired claim

### a claim with a ttl already in the past is removed by clean

```execute
aux4 repository claim --db clean-test.db --repository events --id evt1 --data '{}' --ttl=-10
aux4 bot clean --db clean-test.db
aux4 repository read --db clean-test.db --repository events --id evt1 --raw true || true
```

```expect:partial
events: 1 expired records removed**[]
```

### a live (non-expired) claim is left untouched by clean

```execute
aux4 repository claim --db clean-test.db --repository events --id evt2 --data '{"kind":"message"}' --ttl 3600
aux4 bot clean --db clean-test.db
aux4 repository read --db clean-test.db --repository events --id evt2 --raw true
```

```expect:partial
events: 0 expired records removed**[{"id":"evt2","kind":"message","__metadata":{"ttl":*?,"createdAt":"*?","updatedAt":"*?"}}]
```
