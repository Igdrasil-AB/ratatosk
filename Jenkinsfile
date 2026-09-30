#!/usr/bin/env groovy

// Branch-authored PR CI is deliberately unprivileged. Release and CodeQL upload
// credentials belong to controller-owned jobs, never this Jenkinsfile.
pipeline {
    agent none

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds(abortPrevious: true)
        timeout(time: 45, unit: 'MINUTES')
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '50', artifactNumToKeepStr: '10'))
    }

    stages {
        stage('Node matrix') {
            matrix {
                axes {
                    axis { name 'NODE_MAJOR'; values '20', '22', '24' }
                }
                agent { label 'dagger' }
                stages {
                    stage('Typecheck, policy, and unit tests') {
                        steps {
                            checkout scm
                            sh '''#!/usr/bin/env bash
                                set -euo pipefail
                                case "$NODE_MAJOR" in
                                  20) image='node:20.19.0-bookworm@sha256:a5fb035ac1dff34a4ecaea85f90f7321185695d3fd22c12ba12f4535a4647cc5' ;;
                                  22) image='node:22.12.0-bookworm@sha256:0e910f435308c36ea60b4cfd7b80208044d77a074d16b768a81901ce938a62dc' ;;
                                  24) image='node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059' ;;
                                  *) exit 2 ;;
                                esac
                                mkdir -p reports/junit
                                docker run --rm --user "$(id -u):$(id -g)" \
                                  --env HOME=/tmp/node-home --env NODE_MAJOR \
                                  --volume "$PWD:/workspace" --workdir /workspace "$image" \
                                  bash -lc '
                                    set -euo pipefail
                                    npm ci
                                    npm run audit:security
                                    npm run gen:icons
                                    npm run typecheck
                                    npm run check:boundaries
                                    npm run validate
                                    npm run validate:release
                                    npm test -- --reporter=default --reporter=junit \
                                      --outputFile.junit="reports/junit/node-${NODE_MAJOR}.xml"
                                    test -s "reports/junit/node-${NODE_MAJOR}.xml"
                                    if [[ "$NODE_MAJOR" == 24 ]]; then
                                      npm run build:collector
                                      npm run package:collector
                                      npm run verify:collector-artifact
                                    fi
                                  '
                            '''
                        }
                    }
                }
                post {
                    always {
                        script {
                            try {
                                junit testResults: "reports/junit/node-${env.NODE_MAJOR}.xml", allowEmptyResults: false
                            } finally {
                                deleteDir()
                            }
                        }
                    }
                }
            }
        }

        stage('Built Collector and Chromium') {
            agent { label 'dagger' }
            steps {
                checkout scm
                sh '''#!/usr/bin/env bash
                    set -euo pipefail
                    docker run --rm --user "$(id -u):$(id -g)" \
                      --shm-size=1g --env HOME=/tmp/node-home \
                      --volume "$PWD:/workspace" --workdir /workspace \
                      mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e \
                      bash -lc '
                        set -euo pipefail
                        npm ci
                        npm run build:collector
                        npm run test:chrome-discovery:junit
                        npm run test:chrome-acquisition:junit
                        npm run package:collector
                        npm run verify:collector-artifact
                        test -s reports/junit/chrome-discovery.xml
                        test -s reports/junit/chrome-acquisition.xml
                      '
                '''
            }
            post {
                always {
                    script {
                        try {
                            junit testResults: 'reports/junit/chrome-*.xml', allowEmptyResults: false
                            archiveArtifacts artifacts: 'artifacts/ratatosk-collector-*.zip.sha256', allowEmptyArchive: true
                        } finally {
                            deleteDir()
                        }
                    }
                }
            }
        }

        stage('Trusted CodeQL') {
            when { anyOf { changeRequest(); branch 'main' } }
            agent { label 'dagger' }
            steps {
                checkout scm
                script {
                    def sourceSha = sh(returnStdout: true, script: 'git rev-parse HEAD').trim()
                    if (!(sourceSha ==~ /[0-9a-f]{40}/)) {
                        error('Checkout did not resolve to a full commit SHA')
                    }
                    build job: 'ratatosk/codeql', wait: true, propagate: true,
                        parameters: [
                            string(name: 'SOURCE_KIND', value: env.CHANGE_ID ? 'pr' : 'main'),
                            string(name: 'PR_NUMBER', value: env.CHANGE_ID ?: ''),
                            string(name: 'SOURCE_SHA', value: sourceSha),
                        ]
                }
            }
            post { always { deleteDir() } }
        }
    }
}
