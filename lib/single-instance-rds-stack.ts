import {
    Duration, RemovalPolicy, Stack, StackProps,
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {InstanceType} from 'aws-cdk-lib/aws-ec2';
import SingleInstanceRds from './single-instance-rds';

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
    constructor(scope: Construct, id: string, props: SingleInstanceRdsStackProps) {
        super(scope, id, props);

        new SingleInstanceRds({
            scope: this,
            appName: props.appName,
            bastionKeyPairName: props.bastionKeyPairName,
            myIpAddress: props.myIpAddress,
            dbInstanceType: props.dbInstanceType,
            dbStorageGib: props.dbStorageGib,
            passwordRotationInterval: props.passwordRotationInterval,
            rdsPort: props.rdsPort,
            removalPolicy: props.removalPolicy,
        });
    }
}
