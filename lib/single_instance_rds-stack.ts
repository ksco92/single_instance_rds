import {
    CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags,
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
import {RetentionDays} from 'aws-cdk-lib/aws-logs';

// TODO: VPC flow logs
// TODO: Cloudtrail

interface SingleInstanceRdsStackProps extends StackProps {
    appName: string;
    bastionKeyPairName: string;
    myIpAddress: string;
    dbInstanceType?: InstanceType;
    dbStorageGib?: number;
    passwordRotationInterval?: Duration;
    rdsPort?: number;
    removalPolicy?: RemovalPolicy;
}

export default class SingleInstanceRdsStack extends Stack {
    vpc: Vpc;

    rdsSecurityGroup: SecurityGroup;

    bastionSecurityGroup: SecurityGroup;

    rds: DatabaseInstance;

    bastion: Instance;

    constructor(scope: Construct, id: string, props: SingleInstanceRdsStackProps) {
        super(scope, id, props);

        const dbInstanceType = props.dbInstanceType
            ? props.dbInstanceType
            : InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO);
        const dbStorageGib = props.dbStorageGib ? props.dbStorageGib : 20;
        const passwordRotationInterval = props.passwordRotationInterval
            ? props.passwordRotationInterval
            : Duration.days(1);
        const rdsPort = props.rdsPort ? props.rdsPort : 5432;
        const removalPolicy = props.removalPolicy ? props.removalPolicy : RemovalPolicy.DESTROY;

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Networking

        // VPC with 2 private and 2 public subnets
        this.vpc = new Vpc(this, 'MainVPC', {
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
        this.vpc.addInterfaceEndpoint('SMEndpoint', {
            service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            subnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // RDS security group
        this.rdsSecurityGroup = new SecurityGroup(this, 'RDSSecurityGroup', {
            securityGroupName: 'RDSSecurityGroup',
            vpc: this.vpc,
        });

        // Credential rotation Lambda security group
        const rdsRotationSecurityGroup = new SecurityGroup(this, 'RDSRotationSecurityGroup', {
            securityGroupName: 'RDSRotationSecurityGroup',
            vpc: this.vpc,
        });

        // Bastion security
        this.bastionSecurityGroup = new SecurityGroup(this, 'BastionSecurityGroup', {
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
        this.rds = new DatabaseInstance(this, 'RDSDB', {
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.VER_16,
            }),
            vpc: this.vpc,
            allowMajorVersionUpgrade: true,
            credentials: Credentials.fromGeneratedSecret(props.appName, {
                secretName: props.appName,
                encryptionKey: new Key(this, 'RDSDBSecretKMSKey', {
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
            storageEncryptionKey: new Key(this, 'RDSDBKMSKey', {
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
        this.bastion = new Instance(this, 'BastionHost', {
            instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
            machineImage: MachineImage.latestAmazonLinux2023(),
            vpc: this.vpc,
            vpcSubnets: {
                subnetType: SubnetType.PUBLIC,
            },
            keyPair: KeyPair.fromKeyPairName(this, 'BastionKeyPair', props.bastionKeyPairName),
            securityGroup: this.bastionSecurityGroup,
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
        // Dashboard and alarms

        const width = 6;
        const height = 6;

        // DB alarms
        const alarms = [
            // >= 90% CPU for over 3 minutes
            new Alarm(this, 'RDSCPUAlarm', {
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
            new Alarm(this, 'RDSStorageAlarm', {
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

        // Logs widget
        const logQueryWidget = new LogQueryWidget({
            logGroupNames: [
                `/aws/rds/instance/${props.appName}/postgresql`,
            ],
            title: 'Last 100 queries and durations',
            view: LogQueryVisualizationType.TABLE,
            queryString: `
            filter @logStream = '${props.appName}.0'
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

        // VPC ID
        new CfnOutput(this, 'VpcIdOutput', {
            value: this.vpc.vpcId,
            exportName: 'VpcId',
        });

        // RDS security group
        new CfnOutput(this, 'RDSSecurityGroupOutput', {
            value: this.rdsSecurityGroup.securityGroupId,
            exportName: 'RDSSecurityGroupOutput',
        });

        // Bastion security group
        new CfnOutput(this, 'BastionSecurityGroupOutput', {
            value: this.bastionSecurityGroup.securityGroupId,
            exportName: 'BastionSecurityGroupOutput',
        });

        // Bastion DNS
        new CfnOutput(this, 'BastionHostDNS', {
            value: this.bastion.instancePublicDnsName,
            exportName: 'BastionHostDNS',
        });

        // Secret ARN
        new CfnOutput(this, 'RDSSecretARN', {
            value: this.rds.secret!.secretFullArn!,
            exportName: 'RDSSecretARN',
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Tags

        Tags.of(this).add('project', props.appName);
    }
}
