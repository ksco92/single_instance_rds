import * as cdk from 'aws-cdk-lib';
import {
    CfnOutput, Duration, RemovalPolicy, Tags,
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
    BlockDeviceVolume,
    EbsDeviceVolumeType,
    Instance,
    InstanceClass,
    InstanceSize,
    InstanceType,
    InterfaceVpcEndpointAwsService,
    IpAddresses,
    KeyPair,
    MachineImage, NatProvider,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {
    Credentials,
    DatabaseInstance,
    DatabaseInstanceEngine, PerformanceInsightRetention,
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
import {RetentionDays} from 'aws-cdk-lib/aws-logs';
import {
    APP_NAME,
    BASTION_KEY_PAIR_NAME,
    DB_INSTANCE_TYPE,
    DB_STORAGE_GIB,
    MY_IP_ADDRESS,
    PASSWORD_ROTATION_INTERVAL,
    RDS_PORT,
    REMOVAL_POLICY,
} from './constants';

// TODO: VPC flow logs
// TODO: Cloudtrail

export default class SingleInstanceRdsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Networking

        // VPC with 2 private and 2 public subnets
        const vpc = new Vpc(this, 'MainVPC', {
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
        });

        // Secrets manager endpoint
        vpc.addInterfaceEndpoint('SMEndpoint', {
            service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            subnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // RDS security group
        const rdsSecurityGroup = new SecurityGroup(this, 'RDSSecurityGroup', {
            securityGroupName: 'RDSSecurityGroup',
            vpc,
        });

        // Credential rotation Lambda security group
        const rdsRotationSecurityGroup = new SecurityGroup(this, 'RDSRotationSecurityGroup', {
            securityGroupName: 'RDSRotationSecurityGroup',
            vpc,
        });

        // Bastion security
        const bastionSecurityGroup = new SecurityGroup(this, 'BastionSecurityGroup', {
            securityGroupName: 'BastionSecurityGroup',
            vpc,
        });

        // Rotation Lambda to RDS
        rdsSecurityGroup.addIngressRule(rdsRotationSecurityGroup, Port.tcp(RDS_PORT));

        // Bastion to RDS
        rdsSecurityGroup.addIngressRule(bastionSecurityGroup, Port.tcp(RDS_PORT));

        // SSH to Bastion
        bastionSecurityGroup.addIngressRule(Peer.ipv4(`${MY_IP_ADDRESS}/32`), Port.tcp(22));

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // RDS

        // Database
        const rds = new DatabaseInstance(this, 'RDSDB', {
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.VER_16,
            }),
            vpc,
            allowMajorVersionUpgrade: true,
            credentials: Credentials.fromGeneratedSecret(APP_NAME, {
                secretName: APP_NAME,
                encryptionKey: new Key(this, 'RDSDBSecretKMSKey', {
                    enableKeyRotation: true,
                    alias: 'RDSDBSecretKMSKey',
                    removalPolicy: REMOVAL_POLICY,
                }),
            }),
            databaseName: APP_NAME,
            iamAuthentication: true,
            instanceIdentifier: APP_NAME,
            instanceType: DB_INSTANCE_TYPE,
            removalPolicy: REMOVAL_POLICY,
            storageEncryptionKey: new Key(this, 'RDSDBKMSKey', {
                enableKeyRotation: true,
                alias: 'RDSDBDBKMSKey',
                removalPolicy: REMOVAL_POLICY,
            }),
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
            securityGroups: [
                rdsSecurityGroup,
            ],
            port: RDS_PORT,
            allocatedStorage: DB_STORAGE_GIB,
            storageType: StorageType.GP3,
            monitoringInterval: Duration.minutes(1),
            enablePerformanceInsights: true,
            performanceInsightRetention: PerformanceInsightRetention.MONTHS_3,
            performanceInsightEncryptionKey: new Key(this, 'RDSDBInsightsKMSKey', {
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
        rds.secret!.addRotationSchedule('RDSDBSecretRotation', {
            automaticallyAfter: PASSWORD_ROTATION_INTERVAL,
            hostedRotation: HostedRotation.postgreSqlSingleUser({
                vpc,
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
        const bastion = new Instance(this, 'BastionHost', {
            instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
            machineImage: MachineImage.latestAmazonLinux2023(),
            vpc,
            vpcSubnets: {
                subnetType: SubnetType.PUBLIC,
            },
            keyPair: KeyPair.fromKeyPairName(this, 'BastionKeyPair', BASTION_KEY_PAIR_NAME),
            securityGroup: bastionSecurityGroup,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    mappingEnabled: true,
                    volume: BlockDeviceVolume.ebs(8, {
                        deleteOnTermination: true,
                        volumeType: EbsDeviceVolumeType.GP3,
                        encrypted: true,
                        kmsKey: new Key(this, 'BastionKMSKey', {
                            enableKeyRotation: true,
                            alias: 'BastionKMSKey',
                            removalPolicy: REMOVAL_POLICY,
                        }),
                    }),
                },
            ],
        });

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
            new Alarm(this, 'RDSCPUAlarm', {
                metric: rds.metricCPUUtilization({
                    period: Duration.minutes(1),
                }),
                alarmName: 'RDSCPUAlarm',
                threshold: 90,
                evaluationPeriods: 3,
                comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                datapointsToAlarm: 3,
            }),

            // <=20% disk space for over 3 minutes
            new Alarm(this, 'RDSStorageAlarm', {
                metric: new MathExpression({
                    usingMetrics: {
                        freeSpace: rds.metricFreeStorageSpace({
                            period: Duration.minutes(1),
                        }),
                    },
                    expression: `freeSpace / (${DB_STORAGE_GIB} * 1024 * 1024 * 1024)`,
                    label: 'FreeStorageSpace',
                }),
                alarmName: 'RDSStorageAlarm',
                threshold: 0.2,
                evaluationPeriods: 3,
                comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
                datapointsToAlarm: 3,
            }),
        ];

        // Logs widget
        const logQueryWidget = new LogQueryWidget({
            logGroupNames: [
                `/aws/rds/instance/${APP_NAME}/postgresql`,
            ],
            title: 'Last 100 queries and durations',
            view: LogQueryVisualizationType.TABLE,
            queryString: `
            filter @logStream = '${APP_NAME}.0'
            | filter @message like /execute/
            | fields @timestamp
            | parse @message "duration: * ms  execute <unnamed>: *" as query_duration, sql_query
            | sort @timestamp desc
            | limit 100
            `,
            width: width * 2,
            height: height * 2,
        });

        // CW dashboard
        new Dashboard(this, 'RDSDashboard', {
            dashboardName: 'RDSDashboard',
            widgets: [
                alarms.map((alarm) => new AlarmWidget({
                    alarm,
                    title: alarm.alarmName,
                    height,
                    width,
                })),
                [
                    logQueryWidget,
                ],
            ],
            defaultInterval: Duration.hours(12),
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Outputs

        // Bastion DNS
        new CfnOutput(this, 'BastionHostDNS', {
            value: bastion.instancePublicDnsName,
            exportName: 'BastionHostDNS',
        });

        // Secret ARN
        new CfnOutput(this, 'RDSSecretARN', {
            value: rds.secret!.secretFullArn!,
            exportName: 'RDSSecretARN',
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Tags

        Tags.of(this).add('project', APP_NAME);
    }
}
