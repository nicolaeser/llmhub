FROM node:24-alpine
ARG FIXTURE_VERSION
ARG FIXTURE_FAILURE=none
ENV FIXTURE_VERSION=$FIXTURE_VERSION FIXTURE_FAILURE=$FIXTURE_FAILURE
WORKDIR /fixture
COPY app.mjs health.mjs ./
HEALTHCHECK --interval=1s --timeout=2s --start-period=1s --retries=2 CMD ["node", "health.mjs"]
CMD ["node", "app.mjs"]
