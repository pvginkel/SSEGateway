import org.jenkinsci.plugins.pipeline.modeldefinition.Utils

library('JenkinsPipelineUtils') _

podTemplate(inheritFrom: 'jenkins-agent kaniko', containers: [
    containerTemplates.k8s('k8s')
]) {
    node(POD_LABEL) {
        def k8sNamespace = kubectl.currentNamespace()

        stage('Cloning repo') {
            git branch: 'main',
                credentialsId: '5f6fbd66-b41c-405f-b107-85ba6fd97f10',
                url: 'https://github.com/pvginkel/SSEGateway.git'
        }

        stage('Build validation image') {
            container('kaniko') {
                helmCharts.kaniko(
                    "Dockerfile.validation",
                    ".",
                    [
                        "registry:5000/ssegateway-validation:${currentBuild.number}"
                    ]
                )
            }
        }

        stage('Run validation') {
            container('k8s') {
                def jobName = "ssegateway-validation-${BUILD_NUMBER}"

                try {
                    kubectl.startJob("""\
                        apiVersion: batch/v1
                        kind: Job
                        metadata:
                            name: ${jobName}
                            namespace: ${k8sNamespace}
                            labels:
                                app.kubernetes.io/name: ssegateway-validation
                                app.kubernetes.io/managed-by: jenkins
                                jenkins/build-number: "${BUILD_NUMBER}"
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
                                          resources:
                                              requests:
                                                  cpu: "500m"
                                                  memory: 256Mi
                                        - name: rabbitmq
                                          image: rabbitmq:3
                                    volumes: []
                    """.stripIndent())

                    kubectl.waitForJobContainer(jobName, 'validation', k8sNamespace)

                    def podName = kubectl.getJobPodName(jobName, k8sNamespace)
                    kubectl.savePodLogs(podName, 'validation', k8sNamespace, "validation-raw.log")

                    sh 'mkdir -p test-results'

                    sh """
                        set -euo pipefail

                        awk '
                            /^===JUNIT:.*===\$/ {
                                fname = \$0
                                sub(/^===JUNIT:/, "", fname)
                                sub(/===\$/, "", fname)
                                content = ""
                                capture = 1
                                next
                            }
                            /^===JUNIT_END===\$/ {
                                print content | "base64 -d > test-results/" fname
                                close("base64 -d > test-results/" fname)
                                capture = 0
                                next
                            }
                            capture { content = content (content ? "\\n" : "") \$0 }
                            !capture { print }
                        ' validation-raw.log > validation-stripped.log
                    """
                    utils.cleanLog("validation-stripped.log", "validation.log")

                    def exitCode = kubectl.getContainerExitCode(podName, 'validation', k8sNamespace)

                    // Generate summary from SUITE_RESULT markers.
                    def log = readFile("validation.log")
                    def resultLine = log.split('\n').find { it.startsWith('===SUITE_RESULT:') }
                    if (resultLine) {
                        def parts = resultLine.replace('===SUITE_RESULT:', '').replace('===', '').split(':')
                        def p = parts[1] as int, f = parts[2] as int, s = parts[3] as int
                        currentBuild.description = "${p} passed, ${f} failed, ${s} skipped"
                    }

                    sh 'rm -f validation-raw.log validation-stripped.log'

                    archiveArtifacts artifacts: 'validation.log, test-results/*.xml', allowEmptyArchive: true
                    junit testResults: 'test-results/*.xml', allowEmptyResults: true

                    if (!exitCode) {
                        def failReason = kubectl.getJobFailReason(jobName, k8sNamespace)
                        error("Validation failed: no exit code (pod=${podName}${failReason ? ", reason: ${failReason}" : ""})")
                    } else if (exitCode != '0') {
                        error("Validation failed: exit code ${exitCode}")
                    }
                } finally {
                    kubectl.deleteJob(jobName, k8sNamespace)
                }
            }
        }

        stage("Building SSE Gateway") {
            container('kaniko') {
                helmCharts.kaniko([
                    "registry:5000/ssegateway:${currentBuild.number}",
                    "registry:5000/ssegateway:latest"
                ])
            }
        }

        stage('Update stable branch') {
            withCredentials([
                usernamePassword(
                    credentialsId: '5f6fbd66-b41c-405f-b107-85ba6fd97f10',
                    usernameVariable: 'GIT_USER',
                    passwordVariable: 'GIT_PASS'
                )
            ]) {
                sh '''
                    git push https://${GIT_USER}:${GIT_PASS}@github.com/pvginkel/SSEGateway.git HEAD:stable
                '''
            }
        }

        stage('Deploy Helm charts') {
            build job: 'HelmCharts', wait: false
        }
    }
}
