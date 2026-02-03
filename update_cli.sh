pnpm run build:cli
sudo ln -s $(pwd)/dist/src/cli.js /usr/local/bin/fangorn
chmod +x $(pwd)/dist/src/cli.js