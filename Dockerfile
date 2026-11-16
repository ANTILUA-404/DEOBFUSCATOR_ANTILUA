FROM node:20-bookworm-slim

# The Luraph engine is Python + the Luau CLI. Both have to exist in the image:
# engines/luraph/src/pyenv.js picks python3 on POSIX, harness.js picks bin/luau.
#
# git/cmake/g++ are build-time only: they compile Luau against THIS image's
# glibc. The prebuilt engines/luraph/bin/luau-linux in the repo was linked
# against glibc 2.38, while bookworm ships 2.36, so the dynamic loader refused
# to start it ("version `GLIBC_2.38' not found"). Building here removes that
# class of mismatch entirely. The toolchains are purged afterwards so they are
# not carried into the runtime layers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 ca-certificates git cmake g++ make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY . .

ARG LUAU_TAG=0.739

# --portable: no -march=native, so the binary is not pinned to the build host's
# CPU. The script also applies the writable-vector-metatable patch that
# runtime/envlog.luau requires for Vector3 members.
RUN python3 engines/luraph/build_luau.py --tag "${LUAU_TAG}" --portable \
 && rm -f engines/luraph/bin/luau-linux engines/luraph/bin/luau.exe engines/luraph/bin/luau-ast.exe \
 && chmod +x engines/luraph/bin/luau engines/luraph/bin/luau-ast

# Fail the build instead of shipping an image whose engines cannot start.
#
# The Luau CLI has no -e or --version; both answer "Unrecognized option" and
# exit non-zero, so neither can be used as a probe. `--help` exits 0 and prints
# a "Usage:" banner, which is exactly the criterion lib/profiles/luraph.js uses
# in judgeBinary() for its own startup preflight. smoke.luau then executes real
# code and asserts the vector metatable is still writable, so a build that
# silently lost build_luau.py's lveclib.cpp patch cannot ship.
RUN engines/luraph/bin/luau --help | grep -q "Usage:" \
 && engines/luraph/bin/luau engines/luraph/smoke.luau \
 && node -e "require('./engines/prometheus/src/index.js'); console.log('prometheus ok')"

RUN apt-get purge -y git cmake g++ make \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/luau-build-*

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
