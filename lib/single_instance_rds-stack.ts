import * as cdk from 'aws-cdk-lib';
import {CfnOutput, Duration, Tags} from 'aws-cdk-lib';
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
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {
    Credentials, DatabaseInstance, DatabaseInstanceEngine, StorageType,
} from 'aws-cdk-lib/aws-rds';
import {Key} from 'aws-cdk-lib/aws-kms';
import {HostedRotation} from 'aws-cdk-lib/aws-secretsmanager';
import {
    Alarm, AlarmWidget, ComparisonOperator, Dashboard, MathExpression,
} from 'aws-cdk-lib/aws-cloudwatch';
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
        });

        // Secrets manager endpoint
        vpc.addInterfaceEndpoint('SMEndpoint', {
            service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            subnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        const rdsSecurityGroup = new SecurityGroup(this, 'RDSSecurityGroup', {
            securityGroupName: 'RDSSecurityGroup',
            vpc,
        });

        const rdsRotationSecurityGroup = new SecurityGroup(this, 'RDSRotationSecurityGroup', {
            securityGroupName: 'RDSRotationSecurityGroup',
            vpc,
        });

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

        const rds = new DatabaseInstance(this, 'RDSDB', {
            engine: DatabaseInstanceEngine.POSTGRES,
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
        });

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

        new Dashboard(this, 'RDSDashboard', {
            dashboardName: 'RDSDashboard',
            widgets: [
                alarms.map((alarm) => new AlarmWidget({
                    alarm,
                    title: alarm.alarmName,
                })),
            ],
            defaultInterval: Duration.hours(12),
        });

        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        /// /////////////////////////////////////////////////
        // Outputs

        new CfnOutput(this, 'BastionHostDNS', {
            value: bastion.instancePublicDnsName,
            exportName: 'BastionHostDNS',
        });

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
