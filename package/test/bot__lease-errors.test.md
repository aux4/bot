# Queue lease errors

```afterAll
rm -f strict-empty.db strict-empty.db-wal strict-empty.db-shm
```

## a genuinely empty repository queue returns normally

```execute
aux4 bot work --queue '{"provider":"repository","name":"strict_empty","db":"strict-empty.db","visibility":30}'
```

```expect:json
{
  "leased": false
}
```

## an unavailable provider is an error rather than an empty result

```execute
aux4 bot work --queue '{"provider":"fixture-missing-provider","name":"strict_empty","visibility":30}'
```

```error:partial
Queue lease failed
```
