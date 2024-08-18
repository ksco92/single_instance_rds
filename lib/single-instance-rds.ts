import {
    CfnOutput, Duration, RemovalPolicy, StackProps, Tags,
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
    BlockDeviceVolume,
    EbsDeviceVolumeType,
    FlowLogDestination,
    FlowLogTrafficType,
    Instance,
    InstanceClass,
    InstanceSize,
    InstanceType,
    InterfaceVpcEndpointAwsService,
    IpAddresses,
    KeyPair,
    MachineImage,
    NatProvider,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {
    Credentials,
    DatabaseInstance,
    DatabaseInstanceEngine,
    PerformanceInsightRetention,
    PostgresEngineVersion,
    StorageType,
} from 'aws-cdk-lib/aws-rds';
import {Key} from 'aws-cdk-lib/aws-kms';
import {HostedRotation} from 'aws-cdk-lib/aws-secretsmanager';
import {
    Alarm,
    AlarmWidget,
    ComparisonOperator,
    Dashboard,
    LogQueryVisualizationType,
    LogQueryWidget,
    MathExpression,
} from 'aws-cdk-lib/aws-cloudwatch';
import {LogGroup, RetentionDays} from 'aws-cdk-lib/aws-logs';
import {ServicePrincipal} from 'aws-cdk-lib/aws-iam';
import {NetworkLoadBalancer, NetworkTargetGroup, TargetType} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId} from 'aws-cdk-lib/custom-resources';
import {IpTarget} from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';

// TODO: Cloudtrail

interface SingleInstanceRdsProps extends StackProps {
    scope: Construct;
    appName: string;
    bastionKeyPairName: string;
    myIpAddress: string;
    dbInstanceType?: InstanceType;
    dbStorageGib?: number;
    passwordRotationInterval?: Duration;
    rdsPort?: number;
    removalPolicy?: RemovalPolicy;
    withNlb?: boolean;
    applicationIpAddress?: string;
}

export default class SingleInstanceRds {
    vpc: Vpc;

    rdsSecurityGroup: SecurityGroup;

    bastionSecurityGroup: SecurityGroup;

    rds: DatabaseInstance;

    bastion: Instance;

    nlb?: NetworkLoadBalancer;

    current_timestamp = new Date().toISOString()
        // eslint-disable-next-line prefer-regex-literals
        .replace(new RegExp('\\.', 'g'), '')
        // eslint-disable-next-line prefer-regex-literals
        .replace(new RegExp(':', 'g'), '')
        // eslint-disable-next-line prefer-regex-literals
        .replace(new RegExp('-', 'g'), '');

    constructor(props: SingleInstanceRdsProps) {
        const {scope,} = props;
        const dbInstanceType = props.dbInstanceType
            ? props.dbInstanceType
            : InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO);
        const dbStorageGib = props.dbStorageGib ? props.dbStorageGib : 20;
        const passwordRotationInterval = props.passwordRotationInterval
            ? props.passwordRotationInterval
            : Duration.days(1);
        const rdsPort = props.rdsPort ? props.rdsPort : 5432;
        const removalPolicy = props.removalPolicy ? props.removalPolicy : RemovalPolicy.DESTROY;
        const withNlb = props.withNlb ? props.withNlb : false;
        const applicationIpAddress = props.applicationIpAddress ? props.applicationIpAddress : '';

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Networking

        // Flow logs KMS key
        const flowLogsKmsKey = new Key(scope, 'VPCFlowLogsKMSKey', {
            enableKeyRotation: true,
            alias: 'VPCFlowLogsKMSKey',
            removalPolicy,
        });

        flowLogsKmsKey.grantEncryptDecrypt(new ServicePrincipal('logs.amazonaws.com'));

        // VPC with 2 private and 2 public subnets
        this.vpc = new Vpc(scope, 'MainVPC', {
            ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
            vpcName: 'MainVPC',
            subnetConfiguration: [
                {
                    name: 'private',
                    subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                },
                {
                    name: 'public',
                    subnetType: SubnetType.PUBLIC,
                },
            ],
            maxAzs: 2,
            natGatewayProvider: NatProvider.instanceV2({
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
            }),
            natGateways: 1,
            flowLogs: {
                cw: {
                    destination: FlowLogDestination.toCloudWatchLogs(new LogGroup(scope, 'VPCFlowLogs', {
                        encryptionKey: flowLogsKmsKey,
                        removalPolicy,
                        logGroupName: 'vpcflowlogs',
                        retention: RetentionDays.ONE_YEAR,
                    })),
                    trafficType: FlowLogTrafficType.ALL,
                },
            },
        });

        // Secrets manager endpoint
        this.vpc.addInterfaceEndpoint('SMEndpoint', {
            service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            subnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // RDS security group
        this.rdsSecurityGroup = new SecurityGroup(scope, 'RDSSecurityGroup', {
            securityGroupName: 'RDSSecurityGroup',
            vpc: this.vpc,
        });

        // Credential rotation Lambda security group
        const rdsRotationSecurityGroup = new SecurityGroup(scope, 'RDSRotationSecurityGroup', {
            securityGroupName: 'RDSRotationSecurityGroup',
            vpc: this.vpc,
        });

        // Bastion security
        this.bastionSecurityGroup = new SecurityGroup(scope, 'BastionSecurityGroup', {
            securityGroupName: 'BastionSecurityGroup',
            vpc: this.vpc,
        });

        // Rotation Lambda to RDS
        this.rdsSecurityGroup.addIngressRule(rdsRotationSecurityGroup, Port.tcp(rdsPort));

        // Bastion to RDS
        this.rdsSecurityGroup.addIngressRule(this.bastionSecurityGroup, Port.tcp(rdsPort));

        // SSH to Bastion
        this.bastionSecurityGroup.addIngressRule(Peer.ipv4(`${props.myIpAddress}/32`), Port.tcp(22));

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // RDS

        // Database
        this.rds = new DatabaseInstance(scope, 'RDSDB', {
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.VER_16,
            }),
            vpc: this.vpc,
            allowMajorVersionUpgrade: true,
            credentials: Credentials.fromGeneratedSecret(props.appName, {
                secretName: props.appName,
                encryptionKey: new Key(scope, 'RDSDBSecretKMSKey', {
                    enableKeyRotation: true,
                    alias: 'RDSDBSecretKMSKey',
                    removalPolicy,
                }),
            }),
            databaseName: props.appName,
            iamAuthentication: true,
            instanceIdentifier: props.appName,
            instanceType: dbInstanceType,
            removalPolicy,
            storageEncryptionKey: new Key(scope, 'RDSDBKMSKey', {
                enableKeyRotation: true,
                alias: 'RDSDBDBKMSKey',
                removalPolicy,
            }),
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
            securityGroups: [
                this.rdsSecurityGroup,
            ],
            port: rdsPort,
            allocatedStorage: dbStorageGib,
            storageType: StorageType.GP3,
            monitoringInterval: Duration.minutes(1),
            enablePerformanceInsights: true,
            performanceInsightRetention: PerformanceInsightRetention.MONTHS_3,
            performanceInsightEncryptionKey: new Key(scope, 'RDSDBInsightsKMSKey', {
                enableKeyRotation: true,
                alias: 'RDSDBInsightsKMSKey',
                removalPolicy: RemovalPolicy.DESTROY,
            }),
            cloudwatchLogsRetention: RetentionDays.ONE_YEAR,
            cloudwatchLogsExports: [
                'postgresql',
            ],
            parameters: {
                log_min_duration_statement: '0',
            },
        });

        // Create the rotation credential
        this.rds.secret!.addRotationSchedule('RDSDBSecretRotation', {
            automaticallyAfter: passwordRotationInterval,
            hostedRotation: HostedRotation.postgreSqlSingleUser({
                vpc: this.vpc,
                vpcSubnets: {
                    subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                },
                securityGroups: [
                    rdsRotationSecurityGroup,
                ],
                functionName: 'RDSDBSecretRotation',
            }),
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Bastion

        // EC2 instance
        this.bastion = new Instance(scope, 'BastionHost', {
            instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
            machineImage: MachineImage.latestAmazonLinux2023(),
            vpc: this.vpc,
            vpcSubnets: {
                subnetType: SubnetType.PUBLIC,
            },
            keyPair: KeyPair.fromKeyPairName(scope, 'BastionKeyPair', props.bastionKeyPairName),
            securityGroup: this.bastionSecurityGroup,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    mappingEnabled: true,
                    volume: BlockDeviceVolume.ebs(8, {
                        deleteOnTermination: true,
                        volumeType: EbsDeviceVolumeType.GP3,
                        encrypted: true,
                        kmsKey: new Key(scope, 'BastionKMSKey', {
                            enableKeyRotation: true,
                            alias: 'BastionKMSKey',
                            removalPolicy,
                        }),
                    }),
                },
            ],
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Network load balancer

        if (withNlb) {
            // NLB security group
            const nlbSecurityGroup = new SecurityGroup(scope, 'NLBSecurityGroup', {
                securityGroupName: 'NLBSecurityGroup',
                vpc: this.vpc,
            });

            this.rdsSecurityGroup.addIngressRule(nlbSecurityGroup, Port.tcp(rdsPort));

            // If no IP is passed...
            if (applicationIpAddress === '') {
                throw new Error('Property applicationIpAddress is needed when withNlb === true.');
                // If open to the internet...
            } else if (applicationIpAddress === '0.0.0.0') {
                nlbSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(rdsPort));
            } else {
                nlbSecurityGroup.addIngressRule(Peer.ipv4(`${applicationIpAddress}/32`), Port.tcp(rdsPort));
            }

            // Network load balancer
            this.nlb = new NetworkLoadBalancer(scope, 'RDSNLB', {
                vpc: this.vpc,
                vpcSubnets: {
                    subnetType: SubnetType.PUBLIC,
                },
                internetFacing: true,
                securityGroups: [
                    nlbSecurityGroup,
                ],
                loadBalancerName: 'RDSNLB',
            });

            // RDS private IP
            const getPrivateIp = new AwsCustomResource(scope, `GetPrivateIp${this.current_timestamp}`, {
                onUpdate: {
                    service: 'EC2',
                    action: 'describeNetworkInterfaces',
                    parameters: {
                        Filters: [
                            {
                                Name: 'group-id',
                                Values: [
                                    this.rdsSecurityGroup.securityGroupId,
                                ],
                            },
                        ],
                    },
                    physicalResourceId: PhysicalResourceId.of(`GetPrivateIp${this.current_timestamp}`),
                },
                policy: AwsCustomResourcePolicy.fromSdkCalls({
                    resources: AwsCustomResourcePolicy.ANY_RESOURCE,
                }),
                logRetention: RetentionDays.ONE_DAY,
            });

            // The IP depends on RDS
            getPrivateIp.node.addDependency(this.rds);

            // The NLB depends on the IP
            this.nlb.node.addDependency(getPrivateIp);

            // NLB listener
            this.nlb.addListener('RDSListener', {
                port: rdsPort,
                defaultTargetGroups: [
                    new NetworkTargetGroup(scope, 'RDSTargetGroup', {
                        port: rdsPort,
                        targetType: TargetType.IP,
                        targets: [
                            new IpTarget(getPrivateIp.getResponseField('NetworkInterfaces.0.PrivateIpAddress')),
                        ],
                        vpc: this.vpc,
                        targetGroupName: 'RDSTargetGroup',
                    }),
                ],
            });
        }

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Dashboard and alarms

        const width = 6;
        const height = 6;

        // DB alarms
        const alarms = [
            // >= 90% CPU for over 3 minutes
            new Alarm(scope, 'RDSCPUAlarm', {
                metric: this.rds.metricCPUUtilization({
                    period: Duration.minutes(1),
                }),
                alarmName: 'RDSCPUAlarm',
                threshold: 90,
                evaluationPeriods: 3,
                comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                datapointsToAlarm: 3,
            }),

            // <=20% disk space for over 3 minutes
            new Alarm(scope, 'RDSStorageAlarm', {
                metric: new MathExpression({
                    usingMetrics: {
                        freeSpace: this.rds.metricFreeStorageSpace({
                            period: Duration.minutes(1),
                        }),
                    },
                    expression: `freeSpace / (${dbStorageGib} * 1024 * 1024 * 1024)`,
                    label: 'FreeStorageSpace',
                }),
                alarmName: 'RDSStorageAlarm',
                threshold: 0.2,
                evaluationPeriods: 3,
                comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
                datapointsToAlarm: 3,
            }),
        ];

        // Logs widget for PG queries
        const pgLogQueryWidget = new LogQueryWidget({
            logGroupNames: [
                `/aws/rds/instance/${props.appName}/postgresql`,
            ],
            title: 'Last 100 queries and durations',
            view: LogQueryVisualizationType.TABLE,
            queryString: `
            filter @logStream = '${props.appName}.0'
            | filter @message like /execute/
            | fields @timestamp
            | parse @message /UTC:(?<client_ip>[\\d.]+)\\(\\d+\\):(?<db_user>[^\\s]+)@/
            | parse @message "duration: * ms  execute <unnamed>: *" as query_duration, sql_query
            | sort @timestamp desc
            | limit 100
            `,
            width: width * 3,
            height: height * 3,
        });

        // Logs widget for VPC flow logs
        const flowLogsQueryWidget = new LogQueryWidget({
            logGroupNames: [
                'vpcflowlogs',
            ],
            title: 'Last 100 VPC flow logs',
            view: LogQueryVisualizationType.TABLE,
            queryString: `
            fields @timestamp, @message
            | sort @timestamp desc
            | limit 100
            `,
            width: width * 3,
            height: height * 3,
        });

        // CW dashboard
        new Dashboard(scope, 'RDSDashboard', {
            dashboardName: 'RDSDashboard',
            widgets: [
                alarms.map((alarm) => new AlarmWidget({
                    alarm,
                    title: alarm.alarmName,
                    height,
                    width,
                })),
                [
                    pgLogQueryWidget,
                ],
                [
                    flowLogsQueryWidget,
                ],
            ],
            defaultInterval: Duration.hours(12),
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Outputs

        // VPC ID
        new CfnOutput(scope, 'VpcIdOutput', {
            value: this.vpc.vpcId,
            exportName: 'VpcIdOutput',
        });

        // RDS security group
        new CfnOutput(scope, 'RDSSecurityGroupOutput', {
            value: this.rdsSecurityGroup.securityGroupId,
            exportName: 'RDSSecurityGroupOutput',
        });

        // Bastion security group
        new CfnOutput(scope, 'BastionSecurityGroupOutput', {
            value: this.bastionSecurityGroup.securityGroupId,
            exportName: 'BastionSecurityGroupOutput',
        });

        // Bastion DNS
        new CfnOutput(scope, 'BastionHostDNSOutput', {
            value: this.bastion.instancePublicDnsName,
            exportName: 'BastionHostDNSOutput',
        });

        // Secret ARN
        new CfnOutput(scope, 'RDSSecretARNOutput', {
            value: this.rds.secret!.secretFullArn!,
            exportName: 'RDSSecretARNOutput',
        });

        // NLB DNS
        if (withNlb) {
            new CfnOutput(scope, 'NLBDNSOutput', {
                value: this.nlb!.loadBalancerDnsName,
                exportName: 'NLBDNSOutput',
            });
        }

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Tags

        Tags.of(scope).add('project', props.appName);
    }
}
