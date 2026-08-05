from datetime import datetime

from airflow import DAG
from airflow.operators.python import PythonOperator


def say_hello() -> None:
    print("Hello from Microsoft Fabric Apache Airflow!")


with DAG(
    dag_id="fabric_deploy_hello_world",
    description="Hello-world DAG deployed by Fabric Deploy.",
    schedule=None,
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["fabric-deploy"],
) as dag:
    hello = PythonOperator(
        task_id="say_hello",
        python_callable=say_hello,
    )
