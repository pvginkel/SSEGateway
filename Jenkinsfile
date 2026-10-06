// Tests SSEGateway by running its validation image as a Kubernetes Job beside a RabbitMQ, then
// builds the ssegateway image, pushes the tested commit to the stable branch, and pins the image
// into Zigbee2mqttDeploy, ElectronicsInventoryDeploy, IotDeploy and DnsmasqDeploy, which Argo CD
// syncs to prd.
//
// Controller config:
//   - Job: SSEGateway/SSEGateway
//   - SCM: pvginkel/SSEGateway, branch main
//   - Script Path: Jenkinsfile

library identifier: 'JenkinsPipelineUtils', changelog: false

pipeline {
    agent {
        kubernetes {
            inheritFrom 'jenkins-agent kaniko'
            yamlMergeStrategy merge()
            yaml podYaml(templates: ['k8s'])
        }
    }

    options {
        // Without abortPrevious: an abort between the stable push and the pin write leaves stable
        // ahead of the image the deploy repos run.
        disableConcurrentBuilds()
        skipDefaultCheckout()
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
    }

    triggers {
        githubPush()
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build ssegateway-validation image') {
            steps {
                container('kaniko') {
                    script {
                        helmCharts.kaniko2(
                            dockerfile: 'Dockerfile.validation',
                            destinations: ["registry:5000/ssegateway-validation:${currentBuild.number}"]
                        )
                    }
                }
            }
        }

        stage('Test') {
            steps {
                container('k8s') {
                    script {
                        String namespace = kubectl.currentNamespace()
                        String job = "ssegateway-validation-${currentBuild.number}"
                        try {
                            kubectl.startJob("""\
                                apiVersion: batch/v1
                                kind: Job
                                metadata:
                                  name: ${job}
                                  labels:
                                    app.kubernetes.io/name: ssegateway-validation
                                    app.kubernetes.io/managed-by: jenkins
                                    jenkins/build-number: "${currentBuild.number}"
                                spec:
                                  backoffLimit: 0
                                  activeDeadlineSeconds: 600
                                  ttlSecondsAfterFinished: 3600
                                  template:
                                    spec:
                                      restartPolicy: Never
                                      containers:
                                        - name: validation
                                          image: registry:5000/ssegateway-validation:${currentBuild.number}
                                          imagePullPolicy: Always
                                        - name: rabbitmq
                                          image: rabbitmq:4.3-management
                                """.stripIndent())
                            kubectl.waitForJobContainer(job, 'validation', namespace)
                            String pod = kubectl.getJobPodName(job, namespace)
                            kubectl.savePodLogs(pod, 'validation', namespace, 'validation-raw.log')

                            // The suite writes each JUnit file into its log, base64-encoded between
                            // an ===JUNIT:<file>=== line and an ===JUNIT_END=== line.
                            sh '''
                                set -eu
                                mkdir -p test-results
                                awk '
                                    /^===JUNIT:.*===$/ {
                                        fname = $0
                                        sub(/^===JUNIT:/, "", fname)
                                        sub(/===$/, "", fname)
                                        content = ""
                                        capture = 1
                                        next
                                    }
                                    /^===JUNIT_END===$/ {
                                        print content | "base64 -d > test-results/" fname
                                        close("base64 -d > test-results/" fname)
                                        capture = 0
                                        next
                                    }
                                    capture { content = content (content ? "\\n" : "") $0 }
                                    !capture { print }
                                ' validation-raw.log > validation-stripped.log
                            '''
                            utils.cleanLog('validation-stripped.log', 'validation.log')
                            archiveArtifacts artifacts: 'validation.log, test-results/*.xml', allowEmptyArchive: true
                            junit testResults: 'test-results/*.xml', allowEmptyResults: true

                            // scripts/validation-entrypoint.sh ends the log with
                            // ===SUITE_RESULT:<name>:<passed>:<failed>:<skipped>===.
                            String result = readFile('validation.log').split('\n').find { it.startsWith('===SUITE_RESULT:') }
                            if (result) {
                                String[] counts = result.replace('===SUITE_RESULT:', '').replace('===', '').split(':')
                                currentBuild.description = "${counts[1]} passed, ${counts[2]} failed, ${counts[3]} skipped"
                            }

                            String exitCode = kubectl.getContainerExitCode(pod, 'validation', namespace)
                            if (!exitCode) {
                                String reason = kubectl.getJobFailReason(job, namespace)
                                error("Validation failed: no exit code (pod ${pod}${reason ? ", reason ${reason}" : ''})")
                            } else if (exitCode != '0') {
                                error("Validation failed: exit code ${exitCode}")
                            }
                        } finally {
                            kubectl.deleteJob(job, namespace)
                        }
                    }
                }
            }
        }

        stage('Build ssegateway image') {
            steps {
                container('kaniko') {
                    script {
                        helmCharts.kaniko2(destinations: [
                            "registry:5000/ssegateway:${currentBuild.number}",
                            'registry:5000/ssegateway:latest',
                        ])
                    }
                }
            }
        }

        // The Checkout stage's clone holds no credential to push with, so the push goes from a clone
        // made inside withCredentials.
        stage('Push stable branch') {
            steps {
                script {
                    String commit = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    withCredentials([usernamePassword(
                        credentialsId: '5f6fbd66-b41c-405f-b107-85ba6fd97f10',
                        usernameVariable: 'GIT_USER',
                        passwordVariable: 'GIT_TOKEN')]) {
                        sh """
                            set -eu
                            git clone --quiet "https://\$GIT_USER:\$GIT_TOKEN@github.com/pvginkel/SSEGateway.git" stable
                            git -C stable push --quiet origin '${commit}:refs/heads/stable'
                        """
                    }
                }
            }
        }

        stage('Write image pins') {
            steps {
                container('k8s') {
                    script {
                        List<String> repos = [
                            'pvginkel/Zigbee2mqttDeploy',
                            'pvginkel/ElectronicsInventoryDeploy',
                            'pvginkel/IotDeploy',
                            'pvginkel/DnsmasqDeploy',
                        ]
                        for (int i = 0; i < repos.size(); i++) {
                            cicd.writeVersionPins(repo: repos[i], pins: [
                                'config/prd/values.yaml': ['images.sseGateway': ":${currentBuild.number}"],
                            ])
                        }
                    }
                }
            }
        }
    }

    post {
        aborted {
            script {
                notify.error("${env.JOB_NAME} #${env.BUILD_NUMBER} aborted (timeout or hand)")
            }
        }
    }
}
