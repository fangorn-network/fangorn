pnpm run build
sudo rm -f /usr/local/bin/fangorn
sudo ln -s $(pwd)/lib/cli/cli.js /usr/local/bin/fangorn
chmod +x $(pwd)/lib/cli/cli.js