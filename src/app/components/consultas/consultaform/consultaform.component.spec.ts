import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConsultaformComponent } from './consultaform.component';

describe('ConsultaformComponent', () => {
  let component: ConsultaformComponent;
  let fixture: ComponentFixture<ConsultaformComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConsultaformComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ConsultaformComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
