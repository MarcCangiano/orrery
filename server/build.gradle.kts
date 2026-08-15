plugins {
    java
    application
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.javalin:javalin:6.3.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.1")
    implementation("org.slf4j:slf4j-simple:2.0.16")

    testImplementation(platform("org.junit:junit-bom:5.11.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass = "dev.cangiano.orrery.Main"
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}

/**
 * Prints the drift fixture: the real simulation run over a scripted input
 * sequence, one line of state per tick. tools/drift-check.sh feeds this to the
 * JavaScript implementation and compares.
 */
tasks.register<JavaExec>("driftFixture") {
    group = "verification"
    description = "Print the physics fixture the JS simulation is checked against"
    mainClass = "dev.cangiano.orrery.sim.DriftFixture"
    classpath = sourceSets["main"].runtimeClasspath
    // Gradle's own logging would land in the middle of the JSON otherwise.
    standardOutput = System.out
}
