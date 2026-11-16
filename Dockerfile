FROM node:20-bookworm-slim

# The Luraph engine is Python + the Luau CLI. Both have to exist in the image:
# engines/luraph/src/pyenv.js picks python3 on POSIX, harness.js picks bin/luau.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY . .

# Windows checkouts keep the Linux binary as luau-linux (a file named `luau`
# and one named `luau.exe` cannot coexist on a case-insensitive filesystem).
# Inside the image the engine expects the bare names.
RUN cp engines/luraph/bin/luau-linux engines/luraph/bin/luau \
 && chmod +x engines/luraph/bin/luau engines/luraph/bin/luau-ast

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
