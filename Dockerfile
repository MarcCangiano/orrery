# Two stages so the shipped image carries a JRE and a jar, not a JDK and a
# Gradle cache.
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
# Wrapper and build files first: this layer only rebuilds when the build itself
# changes, not on every source edit.
COPY gradlew settings.gradle.kts ./
COPY gradle ./gradle
COPY server/build.gradle.kts ./server/
RUN ./gradlew --no-daemon :server:dependencies > /dev/null 2>&1 || true
COPY server ./server
RUN ./gradlew --no-daemon :server:installDist

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/server/build/install/server ./
ENV ORRERY_PORT=7070
EXPOSE 7070
# The client is served by the server, so this one process is the whole game.
ENTRYPOINT ["./bin/server"]
