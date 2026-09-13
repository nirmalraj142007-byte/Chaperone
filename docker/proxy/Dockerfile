# The egress allowlist proxy: a real, well-established forward proxy
# (tinyproxy), not a hand-rolled one. This container is the ONLY thing
# attached to both the internal (no-route-to-internet) crawl network and the
# egress network with real internet access — see docker/README.md for the
# topology. Every runtime container's HTTP_PROXY/HTTPS_PROXY points here.
FROM alpine:3.20

RUN apk add --no-cache tinyproxy

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter

EXPOSE 3128

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
