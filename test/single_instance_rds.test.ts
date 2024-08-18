import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import SingleInstanceRdsStack from '../lib/single-instance-rds-stack';

test('Test resource creation', () => {
    const appName = 'mycooldb';

    const app = new App();
    const stack = new SingleInstanceRdsStack(app, 'MyTestStack', {
        appName: 'mycooldb',
        bastionKeyPairName: 'someKey',
        myIpAddress: '1.2.3.4',
    });
    const template = Template.fromStack(stack);

    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    // Networking

    // VPC
    template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        Tags: [
            {
                Key: 'Name',
                Value: 'MainVPC',
            },
            {
                Key: 'project',
                Value: appName,
            },
        ],
    });

    // Flow logs
    template.hasResourceProperties('AWS::EC2::FlowLog', {
        LogDestinationType: 'cloud-watch-logs',
        TrafficType: 'ALL',
    });

    // Flow logs log group
    template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: 'vpcflowlogs',
        RetentionInDays: 365,
    });

    // 4 subnets (2 private, 2 public)
    template.resourceCountIs('AWS::EC2::Subnet', 4);

    // SM endpoint
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);

    // SGs for RDS, rotation Lambda, bastion host, SM endpoint,
    // NAT instance
    template.resourceCountIs('AWS::EC2::SecurityGroup', 5);

    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    // RDS

    // RDS instance
    template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBInstanceIdentifier: appName,
        AllocatedStorage: '20',
        Port: '5432',
        // TODO: Add check for performance insights
        // TODO: Add check for DB encryption
        // TODO: Add check for CW log exports
    });

    // Credential rotation
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
        RotationRules: {
            ScheduleExpression: 'rate(1 day)',
        },
    });

    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    // Bastion

    // Bastion
    template.hasResourceProperties('AWS::EC2::Instance', {
        KeyName: 'someKey',
        // TODO: Add checks for encryption on root drive
    });

    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    // Dashboard and alarms

    // RDS CPU alarm
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'RDSCPUAlarm',
    });

    // RDS storage alarm
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'RDSStorageAlarm',
    });

    // 2 alarms
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);

    // Dashboard
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'RDSDashboard',
        // TODO: Add check for log widget
    });

    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    /// /////////////////////////////////////////////////
    // Output

    template.hasOutput('VpcIdOutput', {
        Export: {
            Name: 'VpcIdOutput',
        },
    });

    template.hasOutput('RDSSecurityGroupOutput', {
        Export: {
            Name: 'RDSSecurityGroupOutput',
        },
    });

    template.hasOutput('BastionSecurityGroupOutput', {
        Export: {
            Name: 'BastionSecurityGroupOutput',
        },
    });

    template.hasOutput('RDSSecretARNOutput', {
        Export: {
            Name: 'RDSSecretARNOutput',
        },
    });
});
