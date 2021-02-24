
# haraka-plugin-milter

For all your Milter needs!

**WARNING**: BETA quality.

**WARNING**: requires patching Haraka base files.

## INSTALL

```sh
cd /path/to/local/haraka
npm install haraka-plugin-milter
echo "haraka-plugin-milter" >> config/plugins
# configure stuff in config/milter.yaml
service haraka restart
```

### Configuration

It's necessary to define at least milter connection parameters before using this plugin. See the default config template for more details. 

```sh
cp node_modules/haraka-plugin-milter/config/milter.yaml config/
$EDITOR config/milter.yaml
```

## Notes

Currently, this is a not-so-completely implemented Milter MTA side that might break on itself or get loose when sending non-standard data. You will have to review the Milter filter side logs, they *might* provide a clue on what the filter side is actually expecting or complaining about. Increase the Haraka `loglevel` to get the gory details on proto talk.
