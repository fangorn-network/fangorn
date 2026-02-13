pnpm run build
sudo rm /usr/local/bin/fangorn
sudo ln -s $(pwd)/lib/cli.js /usr/local/bin/fangorn
chmod +x $(pwd)/lib/cli.js